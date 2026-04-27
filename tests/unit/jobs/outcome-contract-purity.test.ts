import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_ROOT = join(REPO_ROOT, 'src');
const START = 'src/jobs/outcome.ts';
const PRODUCTION_FILES = listProductionSourceFiles(SOURCE_ROOT);
const EDGES = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILES);

function reachableProductionFiles(start: string): Set<string> {
  const visited = new Set<string>();
  const queue = [start];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    for (const edge of EDGES) {
      if (edge.source === current && !visited.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  return visited;
}

describe('jobs outcome contract purity', () => {
  it('keeps the reachable import graph free of store, database, and filesystem dependencies', () => {
    const reachable = reachableProductionFiles(START);
    const bannedPathPrefixes = ['src/store/', 'src/runtime/', 'src/execution/'];
    const directForbiddenPatterns: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
      ['CoralStore', /\bCoralStore\b/],
      ['Database', /\bDatabase\b/],
      ['better-sqlite3', /\bbetter-sqlite3\b/],
      ['node:fs', /from\s+['"]node:fs['"]/],
      ['fs', /from\s+['"]fs['"]/],
      ['node:path', /from\s+['"]node:path['"]/],
      ['path', /from\s+['"]path['"]/],
    ];

    const offendingPaths = [...reachable].filter((filePath) => bannedPathPrefixes.some((prefix) => filePath.startsWith(prefix)));
    expect(offendingPaths).toEqual([]);

    const sourceText = readFileSync(join(REPO_ROOT, START), 'utf-8');
    const offenders = directForbiddenPatterns.filter(([, pattern]) => pattern.test(sourceText)).map(([label]) => label);

    expect(offenders).toEqual([]);
  });
});
