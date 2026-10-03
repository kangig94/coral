import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  handoffRoutingStatusExitContribution,
  handoffRoutingStatusStoreSchema,
  publishGenerationCoordinatedHandoffRoutingTransitions,
  readHandoffRoutingStatus as readHandoffRoutingStatusWithRuntime,
  resolveHandoffRoutingStatus,
  reconcileHandoffRoutingStatus,
  type DurableHandoffRoutingBasis,
  type HandoffRoutingTransition,
  type PublicationOutcome,
} from '#src/coordinator/handoff-routing/status.js';
import { createHandoffRoutingReconciler } from '#src/coordinator/handoff-routing/reconciler.js';
import { formatHandoffRoutingStatus } from '#src/cli/format/backend.js';
import {
  discardHandoffRoutingStatus,
  type HandoffRoutingStatusOperatorOptions,
} from '#src/coordinator/handoff-routing/status-operator.js';
import type { ProcessIdentityObservation } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { acquireOperatorSocketGuard } from '#src/cli/operator-socket-guard.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import type { StoragePort } from '#src/infra/port-types.js';
import {
  handoffRoutingStatusGeneration,
  quarantineHandoffRoutingStoreArtifact,
} from '#src/store/handoff-routing-status-store/index.js';

const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const BUILD_SET_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER = { pid: 101, incarnation: testIncarnation(101) } as const;
const temporaryDirectories: string[] = [];
const runtimeBaseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-runtime-'));
const runtime = createRealRuntime('prod', { baseDir: runtimeBaseDir });

function routingStatusOperatorOptions(runtime: Runtime, path: string): HandoffRoutingStatusOperatorOptions {
  return { runtime, path, acquireSocketGuard: acquireOperatorSocketGuard };
}

function at(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-'));
  temporaryDirectories.push(directory);
  return join(directory, `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`);
}

function selection(
  invocationId: string,
  index: number,
  basis: DurableHandoffRoutingBasis = { kind: 'same-build-set', buildSetId: BUILD_SET_ID },
): HandoffRoutingTransition {
  return {
    kind: 'routing-selected',
    eventId: `event-${index}`,
    invocationId,
    observedAt: at(index),
    owner: OWNER,
    disposition: { kind: 'continue-current', basis },
  };
}

function terminal(invocationId: string, index: number, selectionSequence: number): HandoffRoutingTransition {
  return {
    kind: 'continuation-finalized',
    eventId: `event-${index}`,
    invocationId,
    observedAt: at(index),
    selection: { kind: 'with-selection-sequence', selectionSequence },
    disposition: {
      kind: 'continued-current',
      reason: { kind: 'routing', basis: { kind: 'same-build-set', buildSetId: BUILD_SET_ID } },
    },
  };
}

async function committed(
  path: string,
  transitions: readonly HandoffRoutingTransition[],
): Promise<Extract<PublicationOutcome, { kind: 'committed' }>> {
  const outcome = await publish(path, transitions);
  expect(outcome.kind).toBe('committed');
  if (outcome.kind !== 'committed') throw new Error(`Expected a commit, received ${outcome.kind}`);
  return outcome;
}

function unsupportedWalDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=1');
  } finally {
    database.close();
  }
  if (existsSync(`${path}-wal`)) unlinkSync(`${path}-wal`);
  if (existsSync(`${path}-shm`)) unlinkSync(`${path}-shm`);
}

function publish(
  path: string,
  transitions: readonly HandoffRoutingTransition[],
  signal?: AbortSignal,
): Promise<PublicationOutcome> {
  return publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, transitions, signal);
}

function readHandoffRoutingStatus(
  path: string,
  probe?: Parameters<typeof readHandoffRoutingStatusWithRuntime>[2],
): ReturnType<typeof readHandoffRoutingStatusWithRuntime> {
  return readHandoffRoutingStatusWithRuntime(runtime, path, probe);
}

function records(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare('SELECT body_json FROM handoff_routing_records ORDER BY sequence').all() as Array<{
        body_json: string;
      }>
    ).map((row) => JSON.parse(row.body_json) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(runtimeBaseDir, { recursive: true, force: true });
});

describe('handoff-routing/status', () => {
  it('reports automatic absence reconciliation and unknown retry causes without soliciting resolution', async () => {
    const path = databasePath();
    await committed(path, [selection('pending', 1)]);
    const absent = readHandoffRoutingStatus(path, () => ({ kind: 'absent' }));
    const output = formatHandoffRoutingStatus(absent, 'available', 'active');
    expect(output).toContain('recorded owner is absent');
    expect(output).toContain('Coordinator reconciliation will retire this selection within 1s');
    expect(handoffRoutingStatusExitContribution(absent)).toBe(75);
    expect(formatHandoffRoutingStatus(absent)).toContain('resume when a coordinator starts');
    expect(formatHandoffRoutingStatus(absent, 'available', 'awaiting-kernel')).toContain('reaches kernel readiness');
    for (const cause of ['probe-failed', 'probe-not-available', 'deadline-expired'] as const) {
      const unknown = readHandoffRoutingStatus(path, () => ({ kind: 'unobservable', cause }));
      const unknownOutput = formatHandoffRoutingStatus(unknown, 'available', 'active');
      expect(unknownOutput).toContain(cause);
      expect(unknownOutput).toContain('retry within 1s');
      expect(unknownOutput).not.toContain('command=');
      expect(unknownOutput).not.toContain('force-unobservable');
      expect(unknownOutput).not.toContain('abandon');
    }
    expect(output).not.toContain('routing-status resolve');
    expect(output).not.toContain('command=');
  });

  it('automatically retires absent owners immediately and newly absent selections on the next interval', async () => {
    const path = databasePath();
    await committed(path, [selection('absent-at-boot', 1)]);
    const observe = vi.fn<Runtime['process']['observeProcessIdentities']>(async (owners) =>
      owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' } })),
    );
    const reconciliationRuntime = { ...runtime, process: { ...runtime.process, observeProcessIdentities: observe } };
    const onError = vi.fn();
    const reconciler = createHandoffRoutingReconciler(reconciliationRuntime, path, onError);
    const retired = (id: string) => {
      const status = readHandoffRoutingStatus(path);
      expect(status.kind).toBe('current');
      if (status.kind !== 'current') throw new Error('Expected current status');
      expect(status.statuses).toContainEqual(
        expect.objectContaining({
          kind: 'retired',
          tombstone: expect.objectContaining({
            invocationId: id,
            retirementCause: 'operator-resolved',
            resolutionReason: 'owner-absent',
            terminalExisted: false,
          }),
        }),
      );
    };
    try {
      reconciler.start();
      await vi.waitFor(() => retired('absent-at-boot'));
      await committed(path, [selection('absent-after-boot', 2)]);
      await vi.waitFor(() => retired('absent-after-boot'), { timeout: 1_500, interval: 20 });
      expect(observe.mock.calls.every(([, budget]) => budget <= 500)).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      reconciler.stop();
    }
  });

  it('retains capacity eviction as non-gating history after absent owners retire with no further traffic', async () => {
    const path = databasePath();
    await committed(
      path,
      Array.from({ length: 65 }, (_, index) => selection(`capacity-${index}`, index)),
    );
    const initial = readHandoffRoutingStatus(path, () => ({ kind: 'absent' }));
    if (initial.kind !== 'current') throw new Error('Expected current status');
    const eviction = initial.statuses.find(
      (status) => status.kind === 'retired' && status.tombstone.retirementCause === 'selection-evicted-at-capacity',
    );
    expect(eviction).toBeDefined();
    if (eviction === undefined) throw new Error('Expected capacity eviction');
    const history = { ...initial, statuses: [eviction] };
    expect(handoffRoutingStatusExitContribution(history)).toBe(0);
    const output = formatHandoffRoutingStatus(history);
    expect(output).toContain('selection-evicted-at-capacity');
    expect(output).toContain('terminal recorded: no');
    expect(output).toContain('retained history. No action is needed.');
    expect(output).not.toContain('command=');
    expect(output).not.toContain('routing-status resolve');
    expect(handoffRoutingStatusExitContribution(initial)).toBe(75);

    const absentRuntime: Runtime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' } })),
      },
    };
    for (let sweep = 0; sweep < 4; sweep++) {
      await reconcileHandoffRoutingStatus(absentRuntime, path, new AbortController().signal);
    }
    const final = readHandoffRoutingStatus(path);
    if (final.kind !== 'current') throw new Error('Expected current status');
    expect(final.statuses.some((status) => status.kind === 'unresolved')).toBe(false);
    expect(final.statuses).toContainEqual(eviction);
    expect(handoffRoutingStatusExitContribution(final)).toBe(0);
    expect(formatHandoffRoutingStatus(final)).toContain('retained history. No action is needed.');
  });

  it.each([
    { kind: 'incarnation', incarnation: OWNER.incarnation },
    { kind: 'unobservable', cause: 'probe-failed' },
    { kind: 'unobservable', cause: 'probe-not-available' },
    { kind: 'unobservable', cause: 'deadline-expired' },
  ] as const)('retains owners observed as $kind $cause for automatic retry', async (evidence) => {
    const path = databasePath();
    await committed(path, [selection('retained', 1)]);
    const observationRuntime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence })),
      },
    };
    const signal = new AbortController().signal;
    expect(await reconcileHandoffRoutingStatus(observationRuntime, path, signal)).toEqual([]);
    expect(readHandoffRoutingStatus(path)).toMatchObject({ kind: 'current', statuses: [{ kind: 'unresolved' }] });
    const absentRuntime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } })),
      },
    };
    expect(await reconcileHandoffRoutingStatus(absentRuntime, path, signal)).toMatchObject([
      { kind: 'resolved', reason: 'owner-absent' },
    ]);
  });

  it('retires a different incarnation but refuses an absent observation returned after its budget', async () => {
    const path = databasePath();
    await committed(path, [selection('reused-pid', 1)]);
    let expired = true;
    let now = runtime.time.monotonicNow();
    const observationRuntime = {
      ...runtime,
      time: { ...runtime.time, monotonicNow: () => now },
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) => {
          if (expired) now += 500n;
          return owners.map((owner) => ({
            owner,
            evidence: { kind: 'incarnation' as const, incarnation: testIncarnation(999) },
          }));
        },
      },
    };
    const signal = new AbortController().signal;
    expect(await reconcileHandoffRoutingStatus(observationRuntime, path, signal)).toEqual([]);
    expect(readHandoffRoutingStatus(path)).toMatchObject({ kind: 'current', statuses: [{ kind: 'unresolved' }] });
    expired = false;
    expect(await reconcileHandoffRoutingStatus(observationRuntime, path, signal)).toMatchObject([
      { kind: 'resolved', reason: 'owner-absent' },
    ]);
  });

  it('preserves a terminal racing owner observation and accepts a terminal after automatic retirement', async () => {
    const path = databasePath();
    const selected = await committed(path, [selection('racing', 1)]);
    const observationRuntime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) => {
          await committed(path, [terminal('racing', 2, selected.sequence)]);
          return owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } }));
        },
      },
    };
    expect(await reconcileHandoffRoutingStatus(observationRuntime, path, new AbortController().signal)).toMatchObject([
      { kind: 'not-published', cause: 'rejected-transition' },
    ]);
    expect(readHandoffRoutingStatus(path)).toMatchObject({ kind: 'current', statuses: [{ kind: 'terminal' }] });
    const late = await committed(path, [selection('late', 3)]);
    const absentRuntime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' as const } })),
      },
    };
    await reconcileHandoffRoutingStatus(absentRuntime, path, new AbortController().signal);
    await committed(path, [terminal('late', 4, late.sequence)]);
    const read = readHandoffRoutingStatus(path);
    expect(read.kind).toBe('current');
    if (read.kind !== 'current') throw new Error('Expected current status');
    expect(read.statuses).toContainEqual(
      expect.objectContaining({
        kind: 'terminal',
        terminal: expect.objectContaining({
          disposition: expect.objectContaining({
            kind: 'terminal-after-operator-resolution',
            resolutionReason: 'owner-absent',
          }),
        }),
      }),
    );
  });

  it('keeps an uncertain resolution commit observable and retries it without claiming success', async () => {
    const path = databasePath();
    await committed(path, [selection('uncertain', 1)]);
    let failCommit = true;
    const uncertainRuntime: Runtime = {
      ...runtime,
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' } })),
      },
      storage: {
        ...runtime.storage,
        openSqliteDatabaseSync: (candidate, options) => {
          const db = runtime.storage.openSqliteDatabaseSync(candidate, options);
          return {
            prepare: (sql) => db.prepare(sql),
            close: () => db.close(),
            exec: (sql) => {
              if (sql === 'COMMIT' && failCommit && !options?.readOnly)
                throw Object.assign(new Error('injected commit failure'), { errcode: 10 });
              db.exec(sql);
            },
          };
        },
      },
    };
    const signal = new AbortController().signal;
    expect(await reconcileHandoffRoutingStatus(uncertainRuntime, path, signal)).toMatchObject([
      { kind: 'commit-outcome-unknown' },
    ]);
    expect(readHandoffRoutingStatus(path)).toMatchObject({ kind: 'current', statuses: [{ kind: 'unresolved' }] });
    failCommit = false;
    expect(await reconcileHandoffRoutingStatus(uncertainRuntime, path, signal)).toMatchObject([{ kind: 'resolved' }]);
  });

  it('does not publish after reconciliation stops during owner observation', async () => {
    const path = databasePath();
    await committed(path, [selection('stopped', 1)]);
    const before = records(path);
    let releaseObservation = () => {};
    const observation = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    let observationStarted = () => {};
    const started = new Promise<void>((resolve) => {
      observationStarted = resolve;
    });
    const observe = vi.fn<Runtime['process']['observeProcessIdentities']>(async (owners) => {
      observationStarted();
      await observation;
      return owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' } }));
    });
    const stoppedRuntime: Runtime = {
      ...runtime,
      time: { ...runtime.time },
      process: {
        ...runtime.process,
        observeProcessIdentities: observe,
      },
    };
    const interval = vi.spyOn(stoppedRuntime.time, 'setInterval');
    const clearInterval = vi.spyOn(stoppedRuntime.time, 'clearInterval');
    const clearTimeout = vi.spyOn(stoppedRuntime.time, 'clearTimeout');
    const onError = vi.fn();
    const reconciler = createHandoffRoutingReconciler(stoppedRuntime, path, onError);
    try {
      reconciler.start();
      await started;
      const [tick] = interval.mock.calls[0];
      const timer = interval.mock.results[0].value;
      expect(clearTimeout).not.toHaveBeenCalled();
      reconciler.stop();
      expect(clearInterval).toHaveBeenCalledWith(timer);
      releaseObservation();
      await vi.waitFor(() => expect(clearTimeout).toHaveBeenCalledTimes(1));
      expect(readHandoffRoutingStatus(path)).toMatchObject({ kind: 'current', statuses: [{ kind: 'unresolved' }] });
      expect(records(path)).toEqual(before);
      tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observe).toHaveBeenCalledTimes(1);
      expect(records(path)).toEqual(before);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      releaseObservation();
      reconciler.stop();
      vi.restoreAllMocks();
    }
  });

  it('refuses owner evidence that expires inside the resolution transaction', async () => {
    const path = databasePath();
    await committed(path, [selection('expired-in-transaction', 1)]);
    let now = runtime.time.monotonicNow();
    const expiredRuntime: Runtime = {
      ...runtime,
      time: { ...runtime.time, monotonicNow: () => now },
      process: {
        ...runtime.process,
        observeProcessIdentities: async (owners) =>
          owners.map((owner) => ({ owner, evidence: { kind: 'pid-absent' } })),
      },
      storage: {
        ...runtime.storage,
        openSqliteDatabaseSync: (candidate, options) => {
          const db = runtime.storage.openSqliteDatabaseSync(candidate, options);
          return {
            prepare: (sql) => db.prepare(sql),
            close: () => db.close(),
            exec: (sql) => {
              db.exec(sql);
              if (sql === 'BEGIN IMMEDIATE') now += 500n;
            },
          };
        },
      },
    };
    expect(await reconcileHandoffRoutingStatus(expiredRuntime, path, new AbortController().signal)).toMatchObject([
      { kind: 'not-published', cause: 'rejected-transition' },
    ]);
    expect(readHandoffRoutingStatus(path)).toMatchObject({ kind: 'current', statuses: [{ kind: 'unresolved' }] });
  });

  it('does not unlink evidence that replaces the validated classifier-created wal', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000060';
    unsupportedWalDatabase(path);
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    const quarantineWalPath = `${quarantinePath}-wal`;
    let movedWalValidated = false;
    let replacementInjected = false;
    const lstatSyncWithReplacement = ((candidate: string, options?: { bigint: true }) => {
      if (candidate === quarantineWalPath && movedWalValidated && !replacementInjected) {
        baseRuntime.storage.unlinkSync(candidate);
        baseRuntime.storage.writeFileSync(candidate, 'replacement wal evidence', { mode: 0o600 });
        replacementInjected = true;
      }
      return options === undefined
        ? baseRuntime.storage.lstatSync(candidate)
        : baseRuntime.storage.lstatSync(candidate, options);
    }) as StoragePort['lstatSync'];
    const discardRuntime: Runtime = {
      ...baseRuntime,
      ids: { ...baseRuntime.ids, uuid: () => quarantineId },
      storage: {
        ...baseRuntime.storage,
        openSync: (candidate, flags, mode) => {
          const fd = baseRuntime.storage.openSync(candidate, flags, mode);
          if (candidate === quarantineWalPath) movedWalValidated = true;
          return fd;
        },
        lstatSync: lstatSyncWithReplacement,
      },
    };

    await expect(discardHandoffRoutingStatus(routingStatusOperatorOptions(discardRuntime, path))).resolves.toEqual({
      kind: 'quarantine-coordinate-occupied',
      quarantineId,
      quarantinePath,
      artifact: 'wal',
    });
    expect(replacementInjected).toBe(true);
    expect(readFileSync(quarantineWalPath, 'utf-8')).toBe('replacement wal evidence');
  });

  it('does not unlink a source replacement created during the quarantine durability barrier', () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000061';
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const root = join(dirname(path), 'handoff-routing-quarantine');
    const quarantinePath = join(root, `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'inode A', { mode: 0o600 });
    let replacementInjected = false;
    const storage: StoragePort = {
      ...baseRuntime.storage,
      syncDirectoryDurableSync: (directory) => {
        const synced = baseRuntime.storage.syncDirectoryDurableSync(directory);
        if (directory === root && !replacementInjected) {
          baseRuntime.storage.unlinkSync(path);
          baseRuntime.storage.writeFileSync(path, 'inode B', { mode: 0o600 });
          replacementInjected = true;
        }
        return synced;
      },
    };

    expect(
      quarantineHandoffRoutingStoreArtifact(
        storage,
        path,
        quarantineId,
        {
          firstMainState: 'non-empty',
          firstWalReceipt: { kind: 'absent' },
          guardedMainState: 'non-empty',
          guardedWalReceipt: { kind: 'absent' },
        },
        () => undefined,
      ),
    ).toEqual({ kind: 'quarantine-coordinate-occupied', quarantineId, quarantinePath, artifact: 'database' });
    expect(replacementInjected).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('inode B');
    expect(readFileSync(quarantinePath, 'utf-8')).toBe('inode A');
  });

  it('reads the previous committed snapshot while a writer holds an immediate transaction', async () => {
    const path = databasePath();
    await committed(path, [selection('visible', 1)]);
    const writer = new DatabaseSync(path);
    try {
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("DELETE FROM handoff_routing_records WHERE invocation_id = 'visible'").run();
      const result = readHandoffRoutingStatus(path);
      expect(result).toMatchObject({ kind: 'current' });
      if (result.kind !== 'current') throw new Error(`Expected current status, received ${result.kind}`);
      expect(result.statuses).toContainEqual(
        expect.objectContaining({
          kind: 'unresolved',
          selection: expect.objectContaining({ invocationId: 'visible' }),
        }),
      );
      writer.exec('ROLLBACK');
    } finally {
      if (writer.isTransaction) writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('rolls back every statement when a later transition is invalid', async () => {
    const path = databasePath();
    await committed(path, [selection('active', 1)]);
    const before = records(path);

    await expect(publish(path, [selection('rolled-back', 2), selection('active', 3)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    expect(records(path)).toEqual(before);
  });

  it('resolves only absent owners and returns typed stale, terminal, and live refusals', async () => {
    const absentId = '123e4567-e89b-42d3-a456-426614174001';
    const liveId = '123e4567-e89b-42d3-a456-426614174002';
    const terminalId = '123e4567-e89b-42d3-a456-426614174003';
    const staleId = '123e4567-e89b-42d3-a456-426614174004';
    const reusedId = '123e4567-e89b-42d3-a456-426614174007';
    const path = databasePath();
    const absentSelection = await committed(path, [selection(absentId, 1)]);
    await committed(path, [selection(liveId, 2)]);
    const terminalSelection = await committed(path, [selection(terminalId, 3)]);
    await committed(path, [terminal(terminalId, 4, terminalSelection.sequence)]);
    await committed(path, [selection(reusedId, 5)]);

    const repairRuntime = (evidence: ProcessIdentityObservation['evidence']) => ({
      ...runtime,
      process: {
        ...runtime.process,
        readProcessIncarnation: (pid: number, platform: NodeJS.Platform) => {
          if (pid === runtime.env.pid()) return runtime.process.readProcessIncarnation(pid, platform);
          throw new Error('repair must use the batch observer for record owners');
        },
        observeProcessIdentities: async (owners: readonly (typeof OWNER)[]) =>
          owners.map((owner) => ({ owner, evidence })),
      },
    });

    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'pid-absent' }), path, {
        invocationId: staleId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({ kind: 'stale', invocationId: staleId });
    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'pid-absent' }), path, {
        invocationId: terminalId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({ kind: 'already-terminal', invocationId: terminalId });
    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'incarnation', incarnation: OWNER.incarnation }), path, {
        invocationId: liveId,
        forceUnobservable: false,
      }),
    ).resolves.toEqual({ kind: 'live-owner', invocationId: liveId });

    const resolved = await resolveHandoffRoutingStatus(repairRuntime({ kind: 'pid-absent' }), path, {
      invocationId: absentId,
      forceUnobservable: false,
    });
    expect(resolved).toMatchObject({
      kind: 'resolved',
      invocationId: absentId,
      reason: 'owner-absent',
    });
    expect(absentSelection.sequence).toBeGreaterThan(0);
    await expect(
      resolveHandoffRoutingStatus(repairRuntime({ kind: 'incarnation', incarnation: testIncarnation(999) }), path, {
        invocationId: reusedId,
        forceUnobservable: false,
      }),
    ).resolves.toMatchObject({ kind: 'resolved', invocationId: reusedId, reason: 'owner-absent' });
    const status = readHandoffRoutingStatus(path);
    expect(status.kind).toBe('current');
    if (status.kind !== 'current') throw new Error(`Expected current status, received ${status.kind}`);
    expect(
      status.statuses.find(
        (candidate) => candidate.kind === 'retired' && candidate.tombstone.invocationId === absentId,
      ),
    ).toMatchObject({
      kind: 'retired',
      tombstone: {
        invocationId: absentId,
        retirementCause: 'operator-resolved',
        resolutionReason: 'owner-absent',
      },
    });
    expect(handoffRoutingStatusExitContribution(status)).toBe(0);
  });
});

describe('handoff-routing quarantine coordinates', () => {
  it('does not discard a source when its quarantine coordinate is a symlink', () => {
    const path = databasePath();
    const directory = dirname(path);
    const quarantineId = '00000000-0000-4000-8000-000000000099';
    const quarantinePath = join(directory, 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    writeFileSync(path, 'routing status evidence', { mode: 0o600 });
    mkdirSync(join(directory, 'handoff-routing-quarantine'));
    symlinkSync(path, quarantinePath);

    const result = quarantineHandoffRoutingStoreArtifact(
      createRealRuntime('prod', { baseDir: directory }).storage,
      path,
      quarantineId,
      {
        firstMainState: 'non-empty',
        firstWalReceipt: { kind: 'absent' },
        guardedMainState: 'non-empty',
        guardedWalReceipt: { kind: 'absent' },
      },
      () => undefined,
    );

    expect(existsSync(path)).toBe(true);
    expect(lstatSync(quarantinePath).isSymbolicLink()).toBe(true);
    expect(result).toEqual({
      kind: 'quarantine-coordinate-occupied',
      quarantineId,
      quarantinePath,
      artifact: 'database',
    });
  });
});

it('claims a regular quarantine coordinate and retains its payload', () => {
  const path = databasePath();
  const quarantineId = '00000000-0000-4000-8000-000000000098';
  const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
  writeFileSync(path, 'routing status evidence', { mode: 0o600 });
  const result = quarantineHandoffRoutingStoreArtifact(
    createRealRuntime('prod', { baseDir: dirname(path) }).storage,
    path,
    quarantineId,
    {
      firstMainState: 'non-empty',
      firstWalReceipt: { kind: 'absent' },
      guardedMainState: 'non-empty',
      guardedWalReceipt: { kind: 'absent' },
    },
    () => undefined,
  );
  expect(result.kind).toBe('quarantined');
  expect(existsSync(path)).toBe(false);
  expect(readFileSync(quarantinePath, 'utf-8')).toBe('routing status evidence');
});
