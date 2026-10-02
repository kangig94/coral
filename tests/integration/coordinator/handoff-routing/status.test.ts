import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  handoffRoutingStatusExitContribution,
  handoffRoutingStatusStoreSchema,
  publishGenerationCoordinatedHandoffRoutingTransitions,
  readHandoffRoutingStatus as readHandoffRoutingStatusWithRuntime,
  resolveHandoffRoutingStatus,
  type DurableHandoffRoutingBasis,
  type HandoffRoutingTransition,
  type PublicationOutcome,
} from '#src/coordinator/handoff-routing/status.js';
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
  it('does not unlink evidence that replaces the validated classifier-created wal', async () => {
    const path = databasePath();
    const quarantineId = '00000000-0000-4000-8000-000000000060';
    unsupportedWalDatabase(path);
    const baseRuntime = createRealRuntime('prod', { baseDir: dirname(path) });
    const quarantinePath = join(dirname(path), 'handoff-routing-quarantine', `${basename(path)}.${quarantineId}`);
    const quarantineWalPath = `${quarantinePath}-wal`;
    let movedWalValidated = false;
    let replacementInjected = false;
    const statSyncWithReplacement = ((candidate: string, options?: { bigint: true }) => {
      if (candidate === quarantineWalPath && movedWalValidated && !replacementInjected) {
        baseRuntime.storage.unlinkSync(candidate);
        baseRuntime.storage.writeFileSync(candidate, 'replacement wal evidence', { mode: 0o600 });
        replacementInjected = true;
      }
      return options === undefined
        ? baseRuntime.storage.statSync(candidate)
        : baseRuntime.storage.statSync(candidate, options);
    }) as StoragePort['statSync'];
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
        statSync: statSyncWithReplacement,
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

  it('publishes all transition statements atomically and rejects every illegal transition row', async () => {
    const path = databasePath();
    await expect(publish(path, [])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(
      publish(path, [{ ...selection('invalid', 1), invocationId: '' } as HandoffRoutingTransition]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });
    await expect(
      publish(path, [
        {
          ...selection('noncanonical-time', 1),
          observedAt: '9999-12-31T23:59:59.99999999999999+23:59',
        },
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });

    const selected = await committed(path, [selection('active', 2)]);
    await expect(publish(path, [{ ...selection('other', 3), eventId: 'event-2' }])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(publish(path, [selection('active', 4)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(publish(path, [terminal('active', 5, 999)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });

    await committed(path, [terminal('active', 6, selected.sequence)]);
    await expect(publish(path, [terminal('active', 7, selected.sequence)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    await expect(
      publish(path, [
        {
          kind: 'operator-resolved',
          eventId: 'event-8',
          invocationId: 'active',
          observedAt: at(8),
          selectionSequence: selected.sequence,
          reason: 'owner-absent',
        },
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });
    await expect(
      publish(path, [
        {
          kind: 'operator-resolved',
          eventId: 'event-9',
          invocationId: 'missing',
          observedAt: at(9),
          selectionSequence: 1,
          reason: 'owner-absent',
        },
      ]),
    ).resolves.toEqual({ kind: 'not-published', cause: 'rejected-transition' });

    const before = records(path);
    await expect(publish(path, [selection('rolled-back', 10), selection('active', 11)])).resolves.toEqual({
      kind: 'not-published',
      cause: 'rejected-transition',
    });
    expect(records(path)).toEqual(before);

    await committed(path, [
      {
        kind: 'execution-failed',
        eventId: 'event-12',
        invocationId: 'gap',
        observedAt: at(12),
        selection: { kind: 'without-selection' },
        disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
      },
    ]);
    expect(records(path).find((event) => event.invocationId === 'gap')).toMatchObject({
      disposition: { kind: 'failed-without-selection' },
    });
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
