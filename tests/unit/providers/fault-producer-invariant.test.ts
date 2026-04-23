import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROVIDERS_ROOT = join(process.cwd(), 'src/providers');

type FaultAuthorityRule = {
  builder: string;
  allowed: Set<string>;
};

const RULES: FaultAuthorityRule[] = [
  {
    builder: 'adapterOutputUnparseable',
    allowed: new Set(['src/providers/bootstrap.ts', 'src/providers/middleware/adapter-parse-guard.ts']),
  },
  {
    builder: 'providerSessionUnavailable',
    allowed: new Set(['src/providers/middleware/session-continuity.ts']),
  },
  {
    builder: 'providerRequestFailed',
    allowed: new Set([
      'src/providers/bootstrap.ts',
      'src/providers/claude/exec-provider.ts',
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

function hasBuilderCall(content: string, builder: string): boolean {
  const callPattern = new RegExp(`\\b${builder}\\s*\\(`);
  const definitionPattern = new RegExp(`\\bfunction\\s+${builder}\\s*\\(`);
  return content.split('\n').some((line) => callPattern.test(line) && !definitionPattern.test(line));
}

describe('provider fault producer authority invariants', () => {
  it('pins each fault builder call to the approved production authorities', () => {
    const files = walk(PROVIDERS_ROOT);

    for (const rule of RULES) {
      const matches = files
        .map((filePath) => ({
          path: toCanonical(filePath),
          content: readFileSync(filePath, 'utf-8'),
        }))
        .filter(({ path, content }) => !isFixtureFile(path) && hasBuilderCall(content, rule.builder))
        .map(({ path }) => path)
        .sort();

      expect(matches, `Unexpected producers for ${rule.builder}`).toEqual([...rule.allowed].sort());
    }
  });
});
