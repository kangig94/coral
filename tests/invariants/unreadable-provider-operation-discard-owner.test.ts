import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { codeTextOnly } from '../helpers/ts-code-text.js';

const REPO_ROOT = join(__dirname, '..', '..');
const SYMBOL = 'discardUnreadableProviderOperationWithRecoveryAuthority';

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [join(REPO_ROOT, root)];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  }
  return files;
}

describe('unreadable provider-operation discard has one recovery owner', () => {
  it('keeps the journal mutation seam inside its store home and the quarantine-owned recovery service', () => {
    const usePattern = new RegExp(`\\b${SYMBOL}\\b`, 'u');
    const owners = sourceFiles('src')
      .filter((path) => usePattern.test(codeTextOnly(readFileSync(path, 'utf-8'))))
      .map((path) => relative(REPO_ROOT, path).replace(/\\/gu, '/'))
      .sort();

    expect(owners).toEqual(
      [
        'src/coordinator/services/recovery/unreadable-provider-operation-discard.ts',
        'src/store/provider-operation-journal.ts',
      ].sort(),
    );
  });
});
