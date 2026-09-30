import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

it.runIf(process.platform === 'linux')('rejects a kernel lock on another device with the same inode', async () => {
  const actual = await vi.importActual<typeof fsModule>('node:fs');
  const runDir = mkdtempSync(join(tmpdir(), 'coral-lock-device-'));
  try {
    const lockPath = supervisorLockPath(runDir);
    writeFileSync(lockPath, 'fixture');
    const inode = statSync(lockPath).ino;
    vi.mocked(readFileSync).mockImplementation(((path, options) =>
      path === '/proc/locks'
        ? `1: POSIX ADVISORY WRITE ${process.pid} fff:fffff:${inode} 0 EOF\n`
        : actual.readFileSync(path, options)) as typeof readFileSync);
    expect(new SupervisorEvidence(runDir).lockHolder()).toBeNull();
  } finally {
    vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
    rmSync(runDir, { recursive: true, force: true });
  }
});
