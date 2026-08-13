#!/usr/bin/env python3
"""StackPilot integration regression suite.

Every test here corresponds to a defect that actually shipped. They exist
because in each case the code *looked* correct and did nothing — the SSRF guard
that missed a route, the permission column that was never read, the WebSocket
that never checked a token. Reading the source was not enough to catch any of
them; only firing a real request was.

Runs against a live stack. No third-party dependencies (stdlib only).

    python tests/integration/test_platform.py
    python tests/integration/test_platform.py --backend http://127.0.0.1:8090

Exit code 0 = all passed, 1 = at least one failure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any, Optional

# Use 127.0.0.1 rather than localhost: on Windows, `localhost` resolves to ::1
# first and Docker's port forward doesn't answer on IPv6, adding ~200ms per call.
BACKEND = "http://127.0.0.1:8090"
AI_SERVICE = "http://127.0.0.1:8010"
FRONTEND = "http://127.0.0.1:3000"
PG_CONTAINER = "stackpilot-postgres"

RESULTS: list[tuple[str, bool, str]] = []


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def psql(sql: str) -> str:
    """Run SQL in the postgres container and return trimmed stdout."""
    proc = subprocess.run(
        ["docker", "exec", PG_CONTAINER, "sh", "-c",
         f'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc {json.dumps(sql)}'],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"psql failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def request(
    method: str,
    url: str,
    body: Optional[dict[str, Any]] = None,
    headers: Optional[dict[str, str]] = None,
) -> tuple[int, str]:
    """Return (status, body). Never raises on HTTP error status."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # connection refused, timeout, ...
        return 0, str(exc)


def check(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((name, passed, detail))
    print(f"  {'PASS' if passed else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not passed else ""))


def mint_mcp_token(scopes: list[str], label: str) -> str:
    """Create a short-lived MCP token directly in the DB and return the raw value."""
    raw = "STACKPILOT_mcp_" + secrets.token_hex(16)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    user_id = psql("SELECT id FROM users LIMIT 1;")
    if not user_id:
        raise RuntimeError("no users in database — cannot run authenticated tests")
    psql(
        "INSERT INTO mcp_tokens (user_id, name, token_hash, token_prefix, permissions, expires_at) "
        f"VALUES ('{user_id}', '{label}', '{digest}', 'test', "
        f"'{json.dumps(scopes)}'::jsonb, NOW() + INTERVAL '10 minutes');"
    )
    return raw


def cleanup(label: str) -> None:
    psql(f"DELETE FROM mcp_tokens WHERE name = '{label}';")


# --------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------
def test_liveness() -> None:
    print("\nliveness")
    status, _ = request("GET", f"{BACKEND}/api/v1/health")
    check("backend /health responds 200", status == 200, f"got {status}")
    status, _ = request("GET", f"{AI_SERVICE}/health")
    check("ai-service /health responds 200", status == 200, f"got {status}")
    status, _ = request("GET", FRONTEND + "/")
    check("frontend responds", status in (200, 307, 308), f"got {status}")


def test_authentication_required() -> None:
    """Unauthenticated callers must not reach data endpoints."""
    print("\nauthentication")
    for path in ("/api/v1/auth/me", "/api/v1/secrets", "/api/v1/projects", "/api/v1/deployments"):
        status, _ = request("GET", BACKEND + path)
        check(f"{path} rejects anonymous", status == 401, f"got {status}")


def test_static_files_not_served() -> None:
    """Regression: document_root was '/app', exposing source and cloned repos."""
    print("\nstatic file exposure")
    for path in ("/mcp-server/src/index.js", "/config.json", "/sql/migrations/001_create_users.sql"):
        status, _ = request("GET", BACKEND + path)
        check(f"{path} is not served", status in (404, 401), f"got {status}")


def test_platform_containers_protected() -> None:
    """Regression: any user could claim and stop stackpilot-postgres."""
    print("\nplatform container protection")
    status, _ = request(
        "POST", f"{BACKEND}/api/v1/infrastructure/claims",
        {"provider_type": "docker", "resource_type": "container",
         "resource_key": "stackpilot-postgres", "name": "stackpilot-postgres"},
    )
    # 401 (anonymous) or 403 (protected) both mean "not claimable".
    check("claiming stackpilot-postgres is refused", status in (401, 403), f"got {status}")


def test_ai_service_requires_token() -> None:
    """Regression: ai-service had no authentication on any route."""
    print("\nai-service authentication")
    status, _ = request("POST", f"{AI_SERVICE}/embeddings", {"texts": ["hi"]})
    check("rejects unauthenticated POST", status == 401, f"got {status}")
    status, _ = request("GET", f"{AI_SERVICE}/health")
    check("health stays public (container healthcheck)", status == 200, f"got {status}")


def test_ai_service_ssrf_guard(service_token: Optional[str]) -> None:
    """Regression: provider_overrides.base_url reached httpx unvalidated.

    The first version of this guard only covered the chat path; the embeddings
    route was a complete bypass. Both are exercised here.
    """
    print("\nai-service SSRF guard")
    if not service_token:
        check("SSRF guard (skipped: STACKPILOT_AI_SERVICE_TOKEN unset)", True)
        return
    headers = {"X-StackPilot-Service-Token": service_token}
    cases = {
        "cloud metadata endpoint": "http://169.254.169.254/latest/meta-data",
        "internal container": "http://stackpilot-postgres:5432",
        "loopback": "http://127.0.0.1:8090",
        "non-http scheme": "file:///etc/passwd",
    }
    for label, url in cases.items():
        status, _ = request(
            "POST", f"{AI_SERVICE}/embeddings",
            {"provider": "openai_compatible",
             "provider_overrides": {"base_url": url, "api_key": "x"},
             "texts": ["hi"]},
            headers,
        )
        check(f"blocks {label}", status == 400, f"got {status}")


def test_mcp_token_scopes() -> None:
    """Regression: `permissions` was stored but never read — every token was full access."""
    print("\nMCP token scopes")
    label = "__itest_scopes"
    try:
        read_only = mint_mcp_token(["read"], label)
        auth = {"Authorization": f"Bearer {read_only}"}

        status, _ = request("GET", f"{BACKEND}/api/v1/projects", headers=auth)
        check("read scope allows GET", status == 200, f"got {status}")

        status, _ = request("POST", f"{BACKEND}/api/v1/projects",
                            {"name": "__itest_denied", "source_type": "github",
                             "repo_url": "https://github.com/x/y"}, auth)
        check("read scope denies POST", status == 401, f"got {status}")

        status, _ = request("DELETE", f"{BACKEND}/api/v1/projects/"
                            "00000000-0000-0000-0000-000000000000", headers=auth)
        check("read scope denies DELETE", status == 401, f"got {status}")
    finally:
        cleanup(label)
        psql("DELETE FROM projects WHERE name LIKE '__itest%';")


def test_agent_policy_gate() -> None:
    """Regression: agent permissions lived in localStorage; the server never saw them."""
    print("\nagent policy")
    label = "__itest_agent"
    try:
        token = mint_mcp_token(["read", "deploy"], label)
        user_id = psql("SELECT id FROM users LIMIT 1;")
        previous = psql(
            f"SELECT coalesce(agent_access_mode, 'ask') FROM ai_preferences WHERE user_id = '{user_id}';"
        ) or "ask"
        psql(
            f"INSERT INTO ai_preferences (user_id, agent_access_mode) VALUES ('{user_id}', 'ask') "
            "ON CONFLICT (user_id) DO UPDATE SET agent_access_mode = 'ask';"
        )

        project = {"name": "__itest_agent_project", "source_type": "github",
                   "repo_url": "https://github.com/x/y"}
        auth = {"Authorization": f"Bearer {token}"}

        status, _ = request("POST", f"{BACKEND}/api/v1/projects", project,
                            {**auth, "X-StackPilot-Agent-Action": "create_project"})
        check("agent action blocked when mode=ask", status == 403, f"got {status}")

        status, _ = request("POST", f"{BACKEND}/api/v1/projects", project, auth)
        check("same request allowed without agent header", status == 201, f"got {status}")

        psql(f"UPDATE ai_preferences SET agent_access_mode = '{previous}' WHERE user_id = '{user_id}';")
    finally:
        cleanup(label)
        psql("DELETE FROM projects WHERE name LIKE '__itest%';")


def test_secrets_are_write_only() -> None:
    """A secrets store that returns values on list is just an env var."""
    print("\nsecrets confidentiality")
    label = "__itest_secrets"
    try:
        token = mint_mcp_token(["read", "deploy"], label)
        auth = {"Authorization": f"Bearer {token}"}
        status, body = request("GET", f"{BACKEND}/api/v1/secrets", headers=auth)
        check("secrets list responds", status == 200, f"got {status}")
        if status == 200:
            check("list never contains a plaintext value",
                  '"value"' not in body, "response included a 'value' field")
    finally:
        cleanup(label)


def test_migration_ledger() -> None:
    """Regression: all migrations re-ran every boot, replaying destructive backfills."""
    print("\nmigration ledger")
    try:
        count = int(psql("SELECT count(*) FROM schema_migrations;"))
        check("schema_migrations is populated", count > 0, f"{count} rows")
        files = int(subprocess.run(
            ["docker", "exec", "stackpilot-backend", "sh", "-c",
             "ls sql/migrations/*.sql | wc -l"],
            capture_output=True, text=True).stdout.strip() or 0)
        check("every migration is recorded", count >= files, f"ledger={count} files={files}")
    except Exception as exc:
        check("migration ledger reachable", False, str(exc))


# --------------------------------------------------------------------------
def main() -> int:
    global BACKEND, AI_SERVICE, FRONTEND

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", default=BACKEND)
    parser.add_argument("--ai-service", default=AI_SERVICE)
    parser.add_argument("--frontend", default=FRONTEND)
    parser.add_argument("--ai-token", default=None,
                        help="STACKPILOT_AI_SERVICE_TOKEN (enables SSRF guard tests)")
    args = parser.parse_args()

    BACKEND, AI_SERVICE, FRONTEND = args.backend, args.ai_service, args.frontend

    service_token = args.ai_token
    if not service_token:
        try:
            with open(".env", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("STACKPILOT_AI_SERVICE_TOKEN="):
                        service_token = line.split("=", 1)[1].strip()
                        break
        except OSError:
            pass

    print("StackPilot integration regression suite")
    print(f"backend={BACKEND}  ai-service={AI_SERVICE}")

    test_liveness()
    test_authentication_required()
    test_static_files_not_served()
    test_platform_containers_protected()
    test_ai_service_requires_token()
    test_ai_service_ssrf_guard(service_token)
    test_mcp_token_scopes()
    test_agent_policy_gate()
    test_secrets_are_write_only()
    test_migration_ledger()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = len(RESULTS) - passed
    print(f"\n{'-' * 52}\n{passed} passed, {failed} failed, {len(RESULTS)} total")
    if failed:
        print("\nfailures:")
        for name, ok, detail in RESULTS:
            if not ok:
                print(f"  - {name}: {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
