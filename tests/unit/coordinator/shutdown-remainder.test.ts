import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  pruneShutdownRemainderRecords,
  readShutdownRemainderStatus,
  recordShutdownRemainder,
  shutdownRemainderPath,
} from '#src/coordinator/shutdown-remainder.js';
import { childTerminationRemainder } from '#src/coordinator/shutdown.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const RUN_DIR = '/run';
const REMAINDER_DIRECTORY = '/run/shutdown-remainder.v1';

type RemainderStorage = Pick<
  StoragePort,
  'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync' | 'unlinkSync' | 'writeAtomicDurableSync'
> & {
  fileNames(): string[];
  readPublished(instanceId: string): string | null;
};

type InitialFile = Readonly<{ name: string; value: string; mtimeMs: number }>;

function storageWith(
  initialFiles: readonly InitialFile[] = [],
  options: Readonly<{ publish?: boolean; refusePrune?: boolean; refuseStatFor?: string }> = {},
): RemainderStorage {
  const files = new Map(
    initialFiles.map(({ name, value, mtimeMs }) => [join(REMAINDER_DIRECTORY, name), { value, mtimeMs }]),
  );
  let directoryExists = initialFiles.length > 0;
  let clock = Math.max(0, ...initialFiles.map(({ mtimeMs }) => mtimeMs));

  const storage = {
    existsSync: (path: string) => (path === REMAINDER_DIRECTORY ? directoryExists : files.has(path)),
    readdirSync: vi.fn((path: string) => {
      if (path !== REMAINDER_DIRECTORY || !directoryExists) throw new Error('missing directory');
      return [...files.keys()].filter((file) => dirname(file) === path).map((file) => basename(file));
    }) as unknown as StoragePort['readdirSync'],
    readFileSync: vi.fn((path: string) => {
      const file = files.get(path);
      if (file === undefined) throw new Error('missing file');
      return file.value;
    }) as StoragePort['readFileSync'],
    statSync: vi.fn((path: string) => {
      if (basename(path) === options.refuseStatFor) throw new Error('stat refused');
      const file = files.get(path);
      if (file === undefined) throw new Error('missing file');
      return {
        size: Buffer.byteLength(file.value),
        mtimeMs: file.mtimeMs,
        isDirectory: () => false,
        isFile: () => true,
      };
    }) as unknown as StoragePort['statSync'],
    unlinkSync: vi.fn((path: string) => {
      if (options.refusePrune === true) throw new Error('prune refused');
      files.delete(path);
    }),
    writeAtomicDurableSync: vi.fn((path: string, data: string | NodeJS.ArrayBufferView) => {
      if (options.publish === false) return false;
      directoryExists = true;
      const value =
        typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
      files.set(path, { value, mtimeMs: ++clock });
      return true;
    }),
    fileNames: () => [...files.keys()].map((file) => basename(file)).sort(),
    readPublished: (instanceId: string) => files.get(join(REMAINDER_DIRECTORY, `${instanceId}.json`))?.value ?? null,
  } satisfies RemainderStorage;

  return storage;
}

const KNOWN_LOSS = {
  label: 'known loss',
  remainder: { owner: 'process-exit' },
  settlement: { cause: 'timed-out', detail: 'known detail' },
} as const;

function recordAt(instanceId: string, entries: readonly unknown[] = [KNOWN_LOSS]) {
  return {
    instanceId,
    recordedAt: '2026-09-07T00:00:00.000Z',
    reason: 'sigterm',
    mode: 'handoff',
    entries,
  };
}

function fileAt(instanceId: string, mtimeMs: number, value: unknown = recordAt(instanceId)): InitialFile {
  return { name: `${instanceId}.json`, value: JSON.stringify(value), mtimeMs };
}

describe('shutdown remainder status', () => {
  it('publishes one record at the instance-owned path with its shutdown metadata', () => {
    const storage = storageWith();

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: RUN_DIR },
        {
          instanceId: 'current-instance',
          reason: 'provider-proxy-lifecycle-fatal',
          mode: 'handoff',
          undischarged: [
            {
              label: 'pending durable launch settlement',
              remainder: { owner: 'process-exit' },
              settlement: { cause: 'timed-out', detail: 'launch settlement did not finish' },
            },
          ],
        },
      ),
    ).toBe(true);

    expect(shutdownRemainderPath(RUN_DIR)).toBe(REMAINDER_DIRECTORY);
    expect(storage.writeAtomicDurableSync).toHaveBeenCalledWith(
      '/run/shutdown-remainder.v1/current-instance.json',
      `${JSON.stringify(
        {
          instanceId: 'current-instance',
          recordedAt: '2026-09-07T00:00:00.000Z',
          reason: 'provider-proxy-lifecycle-fatal',
          mode: 'handoff',
          entries: [
            {
              label: 'pending durable launch settlement',
              remainder: { owner: 'process-exit' },
              settlement: { cause: 'timed-out', detail: 'launch settlement did not finish' },
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  });

  it('reports an absent directory', () => {
    expect(readShutdownRemainderStatus({ storage: storageWith(), runDir: RUN_DIR })).toEqual({
      kind: 'absent',
      path: REMAINDER_DIRECTORY,
    });
  });

  it('skips an unknown successor evidence kind without rejecting readable entries', () => {
    const storage = storageWith([
      fileAt('future-instance', 1, {
        ...recordAt('future-instance'),
        reason: 'provider-proxy-lifecycle-fatal',
        entries: [
          KNOWN_LOSS,
          {
            label: 'future successor',
            remainder: {
              owner: 'successor-recovery',
              evidence: { kind: 'future-recovery', durableKey: 'future-key' },
            },
            settlement: { cause: 'unconfirmed', detail: 'future recovery owns this' },
          },
        ],
      }),
    ]);

    expect(readShutdownRemainderStatus({ storage, runDir: RUN_DIR })).toEqual({
      kind: 'available',
      path: REMAINDER_DIRECTORY,
      status: {
        version: 1,
        records: [{ ...recordAt('future-instance'), reason: 'provider-proxy-lifecycle-fatal' }],
      },
      skippedEntries: [
        {
          recordInstanceId: 'future-instance',
          entryNumber: 2,
          label: 'future successor',
          owner: 'successor-recovery',
        },
      ],
      skippedRecords: [],
    });
  });

  it('counts malformed entries while retaining the rest of their record', () => {
    const storage = storageWith([
      fileAt('malformed-instance', 1, {
        ...recordAt('malformed-instance'),
        entries: [
          { ...KNOWN_LOSS, settlement: { cause: 'rejected', detail: 'known detail' } },
          { label: 'missing settlement', remainder: { owner: 'process-exit' } },
          'not-an-entry',
        ],
      }),
    ]);

    const read = readShutdownRemainderStatus({ storage, runDir: RUN_DIR });
    expect(read).toMatchObject({
      kind: 'available',
      skippedEntries: [
        {
          recordInstanceId: 'malformed-instance',
          entryNumber: 2,
          label: 'missing settlement',
          owner: 'process-exit',
        },
        {
          recordInstanceId: 'malformed-instance',
          entryNumber: 3,
          label: null,
          owner: null,
        },
      ],
      skippedRecords: [],
    });
    if (read.kind !== 'available') throw new Error('expected readable remainder status');
    expect(read.status.records[0]?.entries).toHaveLength(1);
  });

  it('skips corrupt and undecodable files beside readable records', () => {
    const storage = storageWith([
      fileAt('known-instance', 1),
      { name: 'corrupt-instance.json', value: '{not-json', mtimeMs: 2 },
      fileAt('foreign-instance', 3, { instanceId: 'foreign-instance', shape: 'unknown-to-this-build' }),
      { name: 'ignored.tmp', value: 'not a record', mtimeMs: 4 },
    ]);

    expect(readShutdownRemainderStatus({ storage, runDir: RUN_DIR })).toEqual({
      kind: 'available',
      path: REMAINDER_DIRECTORY,
      status: { version: 1, records: [recordAt('known-instance')] },
      skippedEntries: [],
      skippedRecords: ['corrupt-instance.json', 'foreign-instance.json'],
    });
  });

  it('keeps per-record read tolerance when file metadata is unavailable', () => {
    const storage = storageWith([fileAt('known-instance', 1)], { refuseStatFor: 'known-instance.json' });

    expect(readShutdownRemainderStatus({ storage, runDir: RUN_DIR })).toMatchObject({
      kind: 'available',
      status: { records: [recordAt('known-instance')] },
      skippedEntries: [],
      skippedRecords: [],
    });
  });

  it('decodes a record with additive fields', () => {
    const additiveEntry = {
      label: 'future-compatible loss',
      entryAddition: true,
      remainder: {
        owner: 'successor-recovery',
        remainderAddition: true,
        evidence: {
          kind: 'startup-adoption',
          evidenceAddition: true,
          processes: [
            {
              kind: 'durable-cli-runtime',
              jobId: 'job-1',
              pid: 4_242,
              leaderIncarnation: testIncarnation('future-compatible-child'),
              processAddition: true,
            },
          ],
        },
      },
      settlement: {
        cause: 'timed-out',
        detail: 'child remained alive',
        settlementAddition: true,
      },
    };
    const storage = storageWith([
      fileAt('older-instance', 1, {
        ...recordAt('older-instance', [additiveEntry]),
        envelopeAddition: true,
      }),
    ]);

    expect(readShutdownRemainderStatus({ storage, runDir: RUN_DIR })).toMatchObject({
      kind: 'available',
      status: {
        records: [
          {
            ...recordAt('older-instance'),
            entries: [
              {
                label: 'future-compatible loss',
                remainder: {
                  owner: 'successor-recovery',
                  evidence: {
                    kind: 'startup-adoption',
                    processes: [
                      {
                        kind: 'durable-cli-runtime',
                        jobId: 'job-1',
                        pid: 4_242,
                        leaderIncarnation: testIncarnation('future-compatible-child'),
                      },
                    ],
                  },
                },
                settlement: { cause: 'timed-out', detail: 'child remained alive' },
              },
            ],
          },
        ],
      },
      skippedEntries: [],
      skippedRecords: [],
    });
  });

  it('overwrites the same instance without reading a corrupt prior record', () => {
    const storage = storageWith([{ name: 'current-instance.json', value: '{not-json', mtimeMs: 1 }]);

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: RUN_DIR },
        { instanceId: 'current-instance', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toBe(true);

    expect(storage.readFileSync).not.toHaveBeenCalled();
    expect(storage.fileNames()).toEqual(['current-instance.json']);
    expect(JSON.parse(storage.readPublished('current-instance') ?? '')).toEqual(recordAt('current-instance'));
  });

  it('prunes the successor-visible directory to the newest 32 instance files by mtime', () => {
    const storage = storageWith(Array.from({ length: 32 }, (_, index) => fileAt(`instance-${index}`, index + 1)));

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: RUN_DIR },
        { instanceId: 'instance-32', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toBe(true);

    expect(storage.fileNames()).toHaveLength(33);
    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });
    expect(storage.fileNames()).toHaveLength(32);
    expect(storage.fileNames()).not.toContain('instance-0.json');
    expect(storage.fileNames()).toContain('instance-32.json');
  });

  it('does not turn a best-effort startup prune refusal into an error', () => {
    const storage = storageWith(
      Array.from({ length: 32 }, (_, index) => fileAt(`instance-${index}`, index + 1)),
      { refusePrune: true },
    );

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: RUN_DIR },
        { instanceId: 'instance-32', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toBe(true);
    expect(() => pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR })).not.toThrow();
    expect(storage.fileNames()).toHaveLength(33);
  });

  it('does not perform exit-path pruning when publication is refused', () => {
    const storage = storageWith([fileAt('existing-instance', 1)], { publish: false });

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: RUN_DIR },
        { instanceId: 'current-instance', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toBe(false);
    expect(storage.readdirSync).not.toHaveBeenCalled();
    expect(storage.fileNames()).toEqual(['existing-instance.json']);
  });

  it('round-trips startup-adoption evidence for a retained durable child', () => {
    const storage = storageWith();
    const evidence = {
      kind: 'durable-cli-runtime',
      jobId: 'adopted-job',
      pid: 4_242,
      leaderIncarnation: testIncarnation('adopted-child'),
    } as const;
    const remainder = childTerminationRemainder({
      kind: 'children-unresolved-at-deadline',
      processes: [{ kind: 'target-alive', pid: 4_242, stage: 'after-sigkill' }],
      cleanupHandles: 1,
      retainedProcesses: [
        {
          kind: 'recorded-wrapper-group',
          provider: 'codex',
          jobId: 'adopted-job',
          jobDir: '/tmp/coral/jobs/adopted-job',
          publication: { kind: 'durably-published', owner: 'successor-recovery', evidence },
          containment: {
            pid: 4_242,
            incarnation: testIncarnation('adopted-child'),
            processGroupId: 4_242,
            childRoot: null,
          },
        },
      ],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });

    expect(
      recordShutdownRemainder(
        { storage, time: { now: () => 1_788_739_200_000 }, runDir: RUN_DIR },
        {
          instanceId: 'current-instance',
          reason: 'test-teardown',
          mode: 'hard',
          undischarged: [
            {
              label: 'child termination',
              remainder,
              settlement: { cause: 'timed-out', detail: '1 cleanup handle(s) remain owned by launch-coordinator' },
            },
          ],
        },
      ),
    ).toBe(true);

    expect(readShutdownRemainderStatus({ storage, runDir: RUN_DIR })).toMatchObject({
      kind: 'available',
      skippedEntries: [],
      status: {
        records: [
          {
            instanceId: 'current-instance',
            entries: [
              {
                label: 'child termination',
                remainder: {
                  owner: 'successor-recovery',
                  evidence: { kind: 'startup-adoption', processes: [evidence] },
                },
              },
            ],
          },
        ],
      },
    });
  });
});
