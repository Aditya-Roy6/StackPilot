# Tests

Three suites, in increasing order of cost. All three run in CI
(`.github/workflows/ci.yml`) on every push and pull request.

| Suite | Command | Needs |
|---|---|---|
| C++ unit | `docker build --target unit-tests -t stackpilot-unit-tests . && docker run --rm stackpilot-unit-tests` | Docker |
| Frontend unit | `cd frontend && npm test` | Node 20 |
| Integration | `python tests/integration/test_platform.py` | A running stack |

## C++ unit tests — `tests/unit/cpp/`

Pure functions only: no database, no event loop, no network. The suite links
just the translation units under test rather than the whole source glob, so it
builds in seconds after the first run.

`testing.h` is a ~130-line assertion framework rather than GoogleTest. The
builder image ships no gtest and pulling it in would add an apt fetch to every
backend image build. The `TEST()` / `EXPECT_*` names are deliberately
gtest-shaped so the swap is mechanical if the suite ever outgrows it.

| File | What it pins |
|---|---|
| `string_utils_test.cpp` | `shellQuote` — every shell-out in the platform passes through it; a structural check walks the output of hostile inputs and asserts quoting is never broken. Also `trim`, `splitCsv`, `isTruthy`, `parseJsonObject`. |
| `jwt_helper_test.cpp` | The MCP scope gate. `read` cannot mutate, `deploy` cannot delete, unknown scopes grant nothing, and a token with no `permissions` degrades to read-only rather than full access. |
| `compose_planner_test.cpp` | `sanitizeDnsLabel` output is always a valid RFC 1123 label, including after truncation. Plus the plan-time refusals: HTTPS without Ingress, multi-service stacks with no published port. |

Two of these caught nothing in the product and everything in my assumptions:
the planner deliberately falls back to a default port for a *lone* service, and
deliberately downgrades an unsatisfiable `ingress` request to `nodeport`. Both
behaviours are now pinned, because they read like bugs and are not.

## Frontend unit tests — `frontend/`

Logic that runs without a server or a browser. Vitest + jsdom.

| File | What it pins |
|---|---|
| `src/lib/ui-theme.test.ts` | Every theme has picker metadata; the pre-paint init script (assembled by string concatenation, so never type-checked) is valid JS, rejects an unknown `localStorage` value, and never throws when storage is disabled. |
| `src/lib/utils.test.ts` | `cn()` — the last conflicting Tailwind utility wins. Every component's variant override depends on it. |
| `tests/query-keys.test.ts` | Static scan: no React Query key maps to two different endpoints, and no `invalidateQueries` targets a key no query uses. |

That last one exists because of a real crash. The infrastructure page died with
`(ej.data || []).map is not a function` because `["ssh-connections"]` was shared
by one query returning `SshConnection[]` and another returning
`{ connections: SshConnection[] }`. Last writer wins in the cache. TypeScript
cannot see it — each call site is individually well-typed. Only a cross-file
check finds it. The mirror-image bug, an `invalidateQueries` with a key no query
uses, never errors either; the UI just silently keeps showing stale data.

## Integration regression suite — `tests/integration/test_platform.py`

Runs against a live stack (`docker compose up -d`). Stdlib only — no
`pip install`. Exit code 0 = all passed, 1 = at least one failure.

### What it covers, and why

Every test corresponds to a defect that actually shipped:

| Area | The bug it guards against |
|---|---|
| Authentication | Data endpoints reachable without a token |
| Static file exposure | `document_root` was `/app`, serving source and cloned user repos to anonymous callers |
| Platform containers | Any user could claim and stop `stackpilot-postgres`, taking down the platform |
| ai-service auth | The service had no authentication on any route |
| SSRF guard | `provider_overrides.base_url` reached httpx unvalidated — cloud metadata, internal hosts, `file://` |
| MCP token scopes | `permissions` was written to the DB and never read; every token was full access |
| Agent policy | Agent permissions lived in browser `localStorage`; the server never saw them |
| Secrets | A secrets store that returns plaintext on list is just an env var |
| Migration ledger | All migrations re-ran on every boot, replaying destructive backfills |

The common thread: in each case **the code looked correct and did nothing**.
Reading the source did not catch any of them. Only firing a real request did.
Two of these were introduced *while fixing something else* — the SSRF guard
initially covered the chat route but left the embeddings route as a complete
bypass, and dropping the backend to a non-root user silently broke every
application build until the workspace ownership was fixed.

That is the argument for this suite existing: not coverage for its own sake, but
a fast check that the controls still fire.

### Adding a test

Follow the existing shape — one function per area, `check(name, passed, detail)`
per assertion. Tests that need authentication use `mint_mcp_token(scopes, label)`
and must clean up in a `finally` block; the suite is designed to leave no
artifacts behind and is safe to run against a stack with real data.

## Not covered yet

- React component rendering (no `@testing-library/react` wired up); the unit
  tests cover logic modules, not JSX
- A real deployment lifecycle (build → run → teardown); this needs either a
  disposable project fixture or a dedicated test database
- The C++ controllers themselves. They are covered end-to-end by the
  integration suite, but not in isolation — splitting
  `DeploymentController.cpp` into testable services is the prerequisite.
