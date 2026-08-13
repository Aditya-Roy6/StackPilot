import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * React Query caches by key. Two useQuery calls that share a key but call
 * different endpoints are the same cache entry, and whichever resolves last
 * wins — so a component reading `.data.map(...)` gets whatever shape the other
 * query returned.
 *
 * This is not hypothetical. The infrastructure page crashed with
 * "(ej.data || []).map is not a function" because ["ssh-connections"] was used
 * by one query returning `SshConnection[]` and another returning
 * `{ connections: SshConnection[] }`. Nothing in TypeScript catches it: each
 * call site is individually well-typed. Only a cross-file check finds it.
 *
 * The second class of bug covered here is the mirror image: an
 * invalidateQueries() whose key matches no live query. That never errors — the
 * UI just quietly keeps showing stale data after a mutation.
 */

const SRC = path.resolve(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Collapse anything non-literal to `?` so `projectId` and `project.id` match. */
function normalizeKey(raw: string): string {
  return raw
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const literal = /^["'`]([^"'`]*)["'`]$/.exec(trimmed);
      return literal ? literal[1] : "?";
    })
    .filter((part) => part !== "")
    .join(" | ");
}

/** Collapse template interpolations so `/projects/${a}` and `/projects/${b}` match. */
function normalizeEndpoint(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, "?");
}

interface Usage {
  key: string;
  endpoint: string;
  file: string;
  line: number;
}

interface Scan {
  queries: Usage[];
  /** Keys passed to invalidateQueries/removeQueries/refetchQueries. */
  invalidations: Omit<Usage, "endpoint">[];
}

function scan(): Scan {
  const queries: Usage[] = [];
  const invalidations: Omit<Usage, "endpoint">[] = [];

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const rel = path.relative(SRC, file).replace(/\\/g, "/");

    lines.forEach((line, index) => {
      const keyMatch = /queryKey:\s*\[([^\]]*)\]/.exec(line);
      if (!keyMatch) return;

      const key = normalizeKey(keyMatch[1]);
      const location = { key, file: rel, line: index + 1 };

      // A queryKey on the same line as invalidate/remove/refetchQueries is a
      // cache instruction, not a query definition.
      if (/(?:invalidate|remove|refetch|cancel)Queries/.test(line)) {
        invalidations.push(location);
        return;
      }

      // Otherwise it must be a real query: find the queryFn that follows and
      // the GET it performs. Anything without both is not a fetch definition
      // (e.g. a prefetch stub or a setQueryData call) and is skipped.
      const window = lines.slice(index, index + 14).join("\n");
      const fnIndex = window.indexOf("queryFn");
      if (fnIndex === -1) return;

      const body = window.slice(fnIndex);
      const call = /api\.get(?:<[^>]*>)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(body);
      if (!call) return;

      queries.push({ ...location, endpoint: normalizeEndpoint(call[2]) });
    });
  }

  return { queries, invalidations };
}

describe("React Query cache keys", () => {
  const { queries, invalidations } = scan();

  it("finds query usages to check", () => {
    // If a refactor changes how queries are written, this suite must fail
    // loudly rather than pass because it inspected zero call sites.
    expect(queries.length).toBeGreaterThan(20);
    expect(invalidations.length).toBeGreaterThan(5);
  });

  it("never maps one cache key to two different endpoints", () => {
    const byKey = new Map<string, Usage[]>();
    for (const usage of queries) {
      const bucket = byKey.get(usage.key) ?? [];
      bucket.push(usage);
      byKey.set(usage.key, bucket);
    }

    const collisions: string[] = [];
    for (const [key, group] of byKey) {
      const endpoints = new Set(group.map((u) => u.endpoint));
      if (endpoints.size > 1) {
        collisions.push(
          `  [${key}] is used for ${endpoints.size} different endpoints:\n` +
            group.map((u) => `      ${u.endpoint}  (${u.file}:${u.line})`).join("\n")
        );
      }
    }

    expect(collisions.length === 0 ? "" : "\n" + collisions.join("\n\n") + "\n").toBe("");
  });

  it("only invalidates keys that some query actually uses", () => {
    // React Query matches invalidation keys by prefix, so an invalidation is
    // valid if its key is a prefix of any live query key.
    const liveKeys = new Set(queries.map((q) => q.key));
    const orphans = invalidations.filter((inv) => {
      for (const live of liveKeys) {
        if (live === inv.key || live.startsWith(inv.key + " | ")) return true;
      }
      return false;
    }).length === invalidations.length
      ? []
      : invalidations.filter((inv) => {
          for (const live of liveKeys) {
            if (live === inv.key || live.startsWith(inv.key + " | ")) return false;
          }
          return true;
        });

    expect(
      orphans.length === 0
        ? ""
        : "\n" +
            orphans
              .map(
                (o) =>
                  `  ${o.file}:${o.line} invalidates [${o.key}], which no useQuery uses`
              )
              .join("\n") +
            "\n"
    ).toBe("");
  });
});
