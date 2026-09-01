import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codeTextOnly } from '../helpers/ts-code-text.js';

const REPO_ROOT = join(__dirname, '..', '..');
const HANDOFF_CLASSIFIER = 'src/coordinator/handoff.ts';

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('handoff refusal classification ownership', () => {
  it('constructs HandoffEscalationError only where the refusal fact is observed', () => {
    const constructionSites = listTypeScriptFiles(join(REPO_ROOT, 'src'))
      .filter((path) => /\bnew\s+HandoffEscalationError\s*\(/u.test(codeTextOnly(readFileSync(path, 'utf-8'))))
      .map((path) => relative(REPO_ROOT, path).replace(/\\/gu, '/'));

    expect(constructionSites).toEqual([HANDOFF_CLASSIFIER]);
  });
});
