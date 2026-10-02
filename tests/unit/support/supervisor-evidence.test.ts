import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

it.runIf(process.platform === 'linux')(
  'reads the actual owner mode and never substitutes parenthood for missing memory',
  async () => {
    const actual = await vi.importActual<typeof fsModule>('node:fs');
    const runDir = mkdtempSync(join(tmpdir(), 'coral-supervisor-memory-'));
    const memoryLog = join(runDir, 'memory.jsonl');
    try {
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Missing test incarnation');
      writeFileSync(supervisorLockPath(runDir), 'fixture');
      const { dev, ino } = statSync(supervisorLockPath(runDir), { bigint: true });
      const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
      const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
      vi.mocked(readFileSync).mockImplementation(((path, options) =>
        path === '/proc/locks'
          ? `1: POSIX ADVISORY WRITE ${process.pid} ${major.toString(16)}:${minor.toString(16)}:${ino} 0 EOF\n`
          : actual.readFileSync(path, options)) as typeof readFileSync);
      const identity = { pid: process.pid, incarnation };
      writeFileSync(
        join(runDir, 'coordinator.json'),
        JSON.stringify({
          ...identity,
          port: 12345,
          socketPath: join(runDir, 'absent.sock'),
          bundleHash: 'hash',
          flavor: 'prod',
          namespace: 'test',
          startedAt: 1000,
          token: 'token',
          bootToken: 'boot',
          supervision: {
            version: 1,
            launchId: '00000000-0000-4000-8000-000000000001',
            admittedAt: 999,
            parent: identity,
            buildSetId: 'build',
            purpose: 'startup',
          },
        }),
      );
      const evidence = new SupervisorEvidence(runDir, memoryLog);
      expect(evidence.read().owner?.mode).toBeUndefined();
      expect(evidence.memory()).toBeNull();
      const state = {
        owner: { id: 'owner', process: identity, buildSetId: 'build', mode: 'recovering' },
        launch: null,
        attempt: null,
      };
      writeFileSync(memoryLog, JSON.stringify({ kind: 'memory', pid: process.pid, authority: true, state }) + '\n');
      expect(evidence.memory()).toEqual(state);
      expect(evidence.read().owner?.mode).toBe('recovering');
      writeFileSync(memoryLog, JSON.stringify({ kind: 'memory', pid: process.pid, authority: false, state }) + '\n');
      expect(evidence.memory()).toBeNull();
    } finally {
      vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

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
