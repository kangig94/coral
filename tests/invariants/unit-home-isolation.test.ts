import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';

describe('unit HOME isolation', () => {
  it('starts fixture commands without the runner child credentials', () => {
    for (const key of [
      'CORAL_CHILD',
      'CORAL_CHILD_PRINCIPAL_HANDLE',
      'CORAL_CHILD_CREDENTIAL_ID',
      'CORAL_CHILD_CREDENTIAL_KEY',
      'CORAL_JOB_ID',
      'CORAL_SESSION_ID',
    ])
      expect(process.env[key]).toBeUndefined();
  });
  it('resolves ambient runtime paths and subprocess homes inside the isolated home', () => {
    const home = process.env.CORAL_TEST_HOME;
    if (home === undefined) throw new Error('Unit HOME was not configured.');
    expect(homedir()).toBe(home);
    expect(createRealRuntime('prod').paths.coral.store.dbDir).toBe(join(home, '.coral', 'gen2', 'data', 'store'));

    const child = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:os').homedir())"], {
      encoding: 'utf-8',
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(home);
  });
});
