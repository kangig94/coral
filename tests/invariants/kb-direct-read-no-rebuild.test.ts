import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const KB_DIRECT_LIST_READ_FILES = [
  'src/kb/queries.ts',
  'src/kb/tool-handlers.ts',
  'src/kb/ops/source/store.ts',
  'src/kb/ops/principles-list.ts',
  'src/kb/direct-read-index.ts',
] as const;

describe('KB direct list reads do not rebuild durable text artifacts', () => {
  it('keeps principles/source list paths away from KbRuntime.ensureCorpusFreshness()', () => {
    const violations = KB_DIRECT_LIST_READ_FILES.filter((relativePath) => {
      const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
      return /\bensureCorpusFreshness\s*\(/.test(source);
    });

    expect(violations).toEqual([]);
  });
});
