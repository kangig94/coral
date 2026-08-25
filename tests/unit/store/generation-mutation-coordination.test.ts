import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { recordedProcessIdentitySchema } from '#src/infra/process-containment.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  acquireGenerationMaintenanceLease,
  resolveGenerationBoundaryPaths,
  tryAcquireGenerationWriterLease,
  type GenerationWriterLease,
} from '#src/store/generation-mutation-coordination.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const temporaryDirectories: string[] = [];

function coordinationRuntime(
  pid: number,
  incarnation: ReturnType<typeof testIncarnation> | null,
  liveness: 'alive' | 'absent' | 'unknown',
): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-generation-coordination-'));
  temporaryDirectories.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  return {
    ...runtime,
    env: {
      ...runtime.env,
      pid: () => pid,
      platform: () => 'linux',
    },
    process: {
      ...runtime.process,
      readProcessIncarnation: () => incarnation,
      observeLiveness: () => liveness,
    },
  };
}

function writer(runtime: Runtime): GenerationWriterLease {
  const attempt = tryAcquireGenerationWriterLease(runtime, { kind: 'routing-status', name: 'handoff-routing-status' });
  if (attempt.kind !== 'acquired') throw new Error(`Expected writer lease, received ${attempt.kind}`);
  return attempt.lease;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('generation mutation writer identity', () => {
  it('records pid and incarnation in the writer lease contents', () => {
    const pid = 4242;
    const incarnation = testIncarnation(pid);
    const runtime = coordinationRuntime(pid, incarnation, 'alive');
    const lease = writer(runtime);
    try {
      const writersRoot = resolveGenerationBoundaryPaths(runtime).writersRoot;
      const entries = runtime.storage.readdirSync(writersRoot);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (entry === undefined) throw new Error('Expected a writer lease entry');
      const identity = recordedProcessIdentitySchema.parse(
        JSON.parse(runtime.storage.readFileSync(join(writersRoot, entry, 'identity.json'), 'utf-8')),
      );
      expect(identity).toEqual({ pid, incarnation });
    } finally {
      lease.release();
    }
  });

  it('makes a released writer lease unobservable to generation maintenance', async () => {
    const pid = 4247;
    const incarnation = testIncarnation(pid);
    const runtime = coordinationRuntime(pid, incarnation, 'alive');
    const lease = writer(runtime);

    lease.release();

    expect(runtime.storage.readdirSync(resolveGenerationBoundaryPaths(runtime).writersRoot)).toEqual([]);
    const maintenance = await acquireGenerationMaintenanceLease(runtime, 25);
    maintenance.release();
  });

  it('removes a writer lease when the pid has a different incarnation', async () => {
    const pid = 4243;
    const recordedIncarnation = testIncarnation(pid);
    const writerRuntime = coordinationRuntime(pid, recordedIncarnation, 'alive');
    const maintenanceRuntime: Runtime = {
      ...writerRuntime,
      process: {
        ...writerRuntime.process,
        readProcessIncarnation: () => testIncarnation(pid + 1),
        observeLiveness: () => 'alive',
      },
    };
    const lease = writer(writerRuntime);
    try {
      const maintenance = await acquireGenerationMaintenanceLease(maintenanceRuntime);
      maintenance.release();
      expect(
        maintenanceRuntime.storage.readdirSync(resolveGenerationBoundaryPaths(maintenanceRuntime).writersRoot),
      ).toEqual([]);
    } finally {
      lease.release();
    }
  });

  it('removes a writer lease when its recorded pid is absent', async () => {
    const pid = 4245;
    const incarnation = testIncarnation(pid);
    const writerRuntime = coordinationRuntime(pid, incarnation, 'alive');
    const maintenanceRuntime: Runtime = {
      ...writerRuntime,
      process: {
        ...writerRuntime.process,
        readProcessIncarnation: () => incarnation,
        observeLiveness: () => 'absent',
      },
    };
    const lease = writer(writerRuntime);
    try {
      const maintenance = await acquireGenerationMaintenanceLease(maintenanceRuntime);
      maintenance.release();
      expect(
        maintenanceRuntime.storage.readdirSync(resolveGenerationBoundaryPaths(maintenanceRuntime).writersRoot),
      ).toEqual([]);
    } finally {
      lease.release();
    }
  });

  it('retains a writer lease only while pid and incarnation match a live process', async () => {
    const pid = 4246;
    const incarnation = testIncarnation(pid);
    const writerRuntime = coordinationRuntime(pid, incarnation, 'alive');
    let now = writerRuntime.time.now();
    const maintenanceRuntime: Runtime = {
      ...writerRuntime,
      time: {
        ...writerRuntime.time,
        now: () => now,
        sleep: async (milliseconds: number) => {
          now += milliseconds;
        },
      },
    };
    const lease = writer(writerRuntime);
    try {
      await expect(acquireGenerationMaintenanceLease(maintenanceRuntime, 25)).rejects.toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: {
          holder: `routing-status:handoff-routing-status (pid ${pid})`,
        },
      });
      expect(
        maintenanceRuntime.storage.readdirSync(resolveGenerationBoundaryPaths(maintenanceRuntime).writersRoot),
      ).toHaveLength(1);
    } finally {
      lease.release();
    }
  });

  it('reports an unknown observation until the independent heartbeat lease can age out', async () => {
    const pid = 4244;
    const incarnation = testIncarnation(pid);
    const writerRuntime = coordinationRuntime(pid, incarnation, 'alive');
    let now = writerRuntime.time.now();
    const maintenanceRuntime: Runtime = {
      ...writerRuntime,
      time: {
        ...writerRuntime.time,
        now: () => now,
        sleep: async (milliseconds: number) => {
          now += milliseconds;
        },
      },
      process: {
        ...writerRuntime.process,
        readProcessIncarnation: () => incarnation,
        observeLiveness: () => 'unknown',
      },
    };
    const lease = writer(writerRuntime);
    try {
      await expect(acquireGenerationMaintenanceLease(maintenanceRuntime, 25)).rejects.toMatchObject({
        code: 'legacy_source_not_quiescent',
        context: {
          writerObservation: 'unknown',
        },
      });
    } finally {
      lease.release();
    }
  });
});
