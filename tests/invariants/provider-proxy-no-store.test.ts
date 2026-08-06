import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(join(REPO_ROOT, 'src'));
const IMPORT_EDGES = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILE_PATHS);
const CANONICAL_FILES = PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath));

/**
 * The three argv modes `src/coordinator/bootstrap.ts` dispatches. Each runs the same backend artifact as its
 * own process, so "the proxy is safe" is only a third of the claim: a guardian or reaper that opened the
 * store would bypass V2's rule that only the selected build may mutate it, and it would do so from a process
 * that by design outlives the coordinator.
 */
const ROLE_ENTRY_MODULES = [
  'src/provider-proxy/guardian.ts',
  'src/provider-proxy/reaper.ts',
  'src/provider-proxy/proxy.ts',
] as const;

/**
 * What none of the three may reach, at any import depth. Depth is the point: a direct-edge rule is satisfied
 * by routing the same access through one intermediate module, and the property this protects is about what
 * the process can *do*, not about who it imports from.
 */
const FORBIDDEN_ROOTS = [
  // Store access. A role process holds no daemon-owned state; SQLite is the coordinator's alone.
  'src/store/',
  // The coordinator socket and everything that binds or serves it.
  'src/transport/',
  'src/coordinator/',
  // Product read surfaces, which exist only over the store.
  'src/read-model/',
] as const;

const ADJACENCY = new Map<string, string[]>();
for (const { source, target } of IMPORT_EDGES) {
  const existing = ADJACENCY.get(source);
  if (existing === undefined) ADJACENCY.set(source, [target]);
  else existing.push(target);
}

/** Every module reachable from `entry`, with the shortest path that reached each one. */
function reachableFrom(entry: string): Map<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const path = paths.get(current) as readonly string[];
    for (const next of ADJACENCY.get(current) ?? []) {
      if (paths.has(next)) continue;
      paths.set(next, [...path, next]);
      queue.push(next);
    }
  }
  return paths;
}

describe('provider proxy role processes open no store and bind no coordinator socket', () => {
  it.each(ROLE_ENTRY_MODULES)('%s reaches no store, transport, coordinator or read-model module', (entry) => {
    expect(CANONICAL_FILES).toContain(entry);

    const violations = [...reachableFrom(entry)]
      .filter(([module]) => FORBIDDEN_ROOTS.some((root) => module.startsWith(root)))
      // The whole path, not just the endpoint: a transitive violation is only actionable if you can see
      // which hop introduced it.
      .map(([, path]) => path.join(' -> '));

    expect(violations).toEqual([]);
  });

  it('names every argv mode the coordinator bootstrap dispatches', () => {
    // The invariant is worth exactly as much as its coverage of the modes that actually exist. If a fourth
    // role process is ever added, this fails until it is listed above rather than silently excluding it.
    const roleFiles = CANONICAL_FILES.filter((file) =>
      /^src\/provider-proxy\/(guardian|reaper|proxy)\.ts$/u.test(file),
    );

    expect([...roleFiles].sort()).toEqual([...ROLE_ENTRY_MODULES].sort());
  });
});
