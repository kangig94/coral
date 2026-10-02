import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRepairBridge } from '#src/coordinator-launch/repair-bridge.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { SENTINEL_TIMING } from '#src/infra/sentinel-timing.js';

describe('repair bridge handle ownership', () => {
  it('closes a socket carried by a stale attempt message', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-repair-bridge-'));
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Missing test incarnation');
    const record = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, 'build-A');
    const owner = { current: record.read().owner, lost: false, release: () => undefined };
    const bridge = createRepairBridge(record, owner, runDir, SENTINEL_TIMING, 1_000);
    const socket = new Socket();
    try {
      expect(socket.destroyed).toBe(false);
      process.emit('message', { kind: 'coral-supervisor-relay', attemptId: 'stale-attempt', message: {} }, socket);
      expect(socket.destroyed).toBe(true);
    } finally {
      bridge.close();
      socket.destroy();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
