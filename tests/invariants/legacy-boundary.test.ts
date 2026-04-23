import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const LEGACY_IDENTIFIERS = [
  'Persisted' + 'StatusRecord',
  'Persisted' + 'LaunchRecord',
  'Persisted' + 'RuntimeRecord',
  'Persisted' + 'ExitRecord',
  'Persisted' + 'ProgressRecord',
  'Workflow' + 'Checkpoint',
  'Provider' + 'Result',
  'Provider' + 'ProgressEvent',
  'Terminal' + 'Result',
  'Session' + 'ContinuityPatch',
];

const ALLOWLIST = [
  /^src\/jobs\/shell\/legacy-ingest\.ts$/,
  /^src\/providers\/app-server\/driver\.ts$/,
  /^src\/simulation\/(schema|core\/index|normalize)\.ts$/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) {
      if (entry === 'node_modules') {
        continue;
      }
      walk(full, out);
      continue;
    }

    if (stat.isFile() && entry.endsWith('.ts')) {
      out.push(full);
    }
  }

  return out;
}

describe('legacy-boundary invariant (AC7)', () => {
  it('legacy record types appear only in the AC7(b) allowlist', () => {
    const files = walk(join(ROOT, 'src'));
    const violations: string[] = [];

    for (const file of files) {
      const canonical = relative(ROOT, file).split('\\').join('/');
      if (ALLOWLIST.some((pattern) => pattern.test(canonical))) {
        continue;
      }

      const content = readFileSync(file, 'utf-8');
      for (const identifier of LEGACY_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(content)) {
          violations.push(`${canonical}: ${identifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
