import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROVIDERS_ROOT = fileURLToPath(new URL('../', import.meta.url));

type FaultAuthorityRule = {
  needle: string;
  allowed: Set<string>;
};

const RULES: FaultAuthorityRule[] = [
  {
    needle: 'adapter_output_unparseable',
    allowed: new Set([
      'src/providers/fault.ts',
      'src/providers/middleware/adapter-parse-guard.ts',
    ]),
  },
  {
    needle: 'provider_session_unavailable',
    allowed: new Set([
      'src/providers/fault.ts',
      'src/providers/middleware/session-continuity.ts',
    ]),
  },
  {
    needle: 'provider_request_failed',
    allowed: new Set([
      'src/providers/fault.ts',
      'src/providers/claude/exec-kernel.ts',
      'src/providers/claude/session-kernel.ts',
      'src/providers/codex/thread-kernel.ts',
    ]),
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === '__helpers__') {
        continue;
      }
      walk(fullPath, out);
      continue;
    }

    if (stat.isFile() && entry.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

function toCanonical(filePath: string): string {
  return `src/providers/${relative(PROVIDERS_ROOT, filePath).split('\\').join('/')}`;
}

function isFixtureFile(path: string): boolean {
  return path.includes('/test-fixtures/') || path.includes('/middleware-authority/');
}

describe('provider fault producer authority invariants', () => {
  it('pins each fault kind to a single production authority beyond fault.ts', () => {
    const files = walk(PROVIDERS_ROOT);

    for (const rule of RULES) {
      const matches = files
        .map((filePath) => ({
          path: toCanonical(filePath),
          content: readFileSync(filePath, 'utf-8'),
        }))
        .filter(({ path, content }) => !isFixtureFile(path) && content.includes(rule.needle))
        .map(({ path }) => path)
        .sort();

      expect(matches, `Unexpected producers for ${rule.needle}`).toEqual([...rule.allowed].sort());
    }
  });
});
