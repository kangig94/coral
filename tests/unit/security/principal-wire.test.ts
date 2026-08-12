import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkDirectoryError } from '#src/runtime/canonical-work-dir.js';
import { parsePrincipalWire } from '#src/security/principal-wire.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('principal wire project binding', () => {
  it('canonicalizes a bound credential at its decoding boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-principal-wire-'));
    tempDirs.push(root);
    const physical = join(root, 'physical');
    const selected = join(root, 'selected');
    mkdirSync(physical);
    symlinkSync(physical, selected, 'dir');

    const principal = parsePrincipalWire(
      { subject: 'agent', binding: { kind: 'project', root: selected } },
      { transport: 'ipc', credential: { kind: 'child-principal', id: 'child-1' } },
    );
    if (principal === null) throw new Error('Expected a decoded principal.');

    expect(principal.binding).toEqual({ kind: 'project', root: realpathSync(physical) });
  });

  it('refuses an unresolvable bound credential at its decoding boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-principal-wire-refusal-'));
    tempDirs.push(root);
    const missingRoot = join(root, 'deleted-project');

    try {
      parsePrincipalWire(
        { subject: 'agent', binding: { kind: 'project', root: missingRoot } },
        { transport: 'ipc', credential: { kind: 'child-principal', id: 'child-1' } },
      );
      expect.fail(
        'AC11 silent divergence at the credential decoding boundary: an unresolvable work directory was accepted',
      );
    } catch (error: unknown) {
      if (!(error instanceof WorkDirectoryError)) throw error;
      expect(error).toMatchObject({
        code: 'invalid_work_directory',
        workDir: missingRoot,
        baseDir: process.cwd(),
      });
      expect(error.message).toMatch(/ENOENT|no such file or directory/);
    }
  });
});
