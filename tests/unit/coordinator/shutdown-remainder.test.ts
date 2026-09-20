import { describe, expect, it, vi } from 'vitest';

import { recordShutdownRemainder } from '#src/coordinator/shutdown-remainder.js';
import {
  classifyShutdownRemainderFile,
  SHUTDOWN_REMAINDER_RECORD_NAME,
  shutdownRemainderFilesystemSubject,
  shutdownRemainderRecordPath,
  shutdownRemainderStagePath,
} from '#src/infra/shutdown-remainder-record.js';
import { sha256Hex } from '#src/infra/hash.js';
import { childTerminationRemainder } from '#src/coordinator/shutdown.js';
import type { StoragePath, StoragePort } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const RUN_DIR = '/run';
const WRITER = { pid: 4_242, incarnation: null } as const;
const RECORD_PATH = shutdownRemainderRecordPath(RUN_DIR);
const STAGE_PATH = shutdownRemainderStagePath(RUN_DIR, WRITER);

type RemainderStorage = Pick<
  StoragePort,
  | 'mkdirSync'
  | 'lstatSync'
  | 'readFileSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'writeAtomicSync'
  | 'writeAtomicDurableSync'
> & {
  paths(): string[];
  read(path: string): string | null;
};

function storageWith(
  initialFiles: Readonly<Record<string, string>> = {},
  options: Readonly<{
    publish?: boolean;
    refuseUnlink?: boolean;
    refuseFinalRename?: boolean;
    refuseReadFor?: string;
    readErrorCode?: string;
    refuseLstatFor?: string;
    lstatErrorCode?: string;
    replaceStageBeforeFinalRenameWith?: string;
  }> = {},
): RemainderStorage {
  const files = new Map(Object.entries(initialFiles));
  const directories = new Set<string>();

  const storage = {
    readFileSync: vi.fn((rawPath: StoragePath) => {
      const path = String(rawPath);
      if (path === options.refuseReadFor) {
        throw Object.assign(new Error('read refused'), { code: options.readErrorCode ?? 'EIO' });
      }
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      return value;
    }) as StoragePort['readFileSync'],
    lstatSync: vi.fn((rawPath: StoragePath) => {
      const path = String(rawPath);
      if (path === options.refuseLstatFor) {
        throw Object.assign(new Error('lstat refused'), { code: options.lstatErrorCode ?? 'EIO' });
      }
      const isDirectory = directories.has(path);
      if (!isDirectory && !files.has(path)) throw Object.assign(new Error('missing entry'), { code: 'ENOENT' });
      return { isDirectory: () => isDirectory, isFile: () => !isDirectory, isSymbolicLink: () => false };
    }) as unknown as StoragePort['lstatSync'],
    unlinkSync: vi.fn((rawPath: StoragePath) => {
      const path = String(rawPath);
      if (options.refuseUnlink === true) throw Object.assign(new Error('unlink refused'), { code: 'EACCES' });
      if (!files.delete(path)) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    }),
    mkdirSync: vi.fn((path: string) => {
      directories.add(path);
    }),
    renameSync: vi.fn((rawOldPath: StoragePath, rawNewPath: StoragePath) => {
      const oldPath = String(rawOldPath);
      const newPath = String(rawNewPath);
      if (options.replaceStageBeforeFinalRenameWith !== undefined && newPath === RECORD_PATH) {
        files.delete(oldPath);
        files.set(newPath, options.replaceStageBeforeFinalRenameWith);
        throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      }
      if (options.refuseFinalRename === true && newPath === RECORD_PATH) {
        throw Object.assign(new Error('rename refused'), { code: 'EIO' });
      }
      const value = files.get(oldPath);
      if (value === undefined) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      files.delete(oldPath);
      files.set(newPath, value);
    }),
    writeAtomicSync: vi.fn((path: string, data: string | NodeJS.ArrayBufferView) => {
      if (options.publish === false) return false;
      const value =
        typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
      files.set(`${path}.tmp`, value);
      storage.renameSync(`${path}.tmp`, path);
      return true;
    }),
    writeAtomicDurableSync: vi.fn(() => true) as unknown as StoragePort['writeAtomicDurableSync'],
    paths: () => [...files.keys()].sort(),
    read: (path: string) => files.get(path) ?? null,
  } satisfies RemainderStorage;

  return storage;
}

function writeRuntime(storage: RemainderStorage) {
  return {
    storage,
    time: { now: () => 1_788_739_200_000 },
    runDir: RUN_DIR,
    writer: WRITER,
  } as const;
}

const KNOWN_LOSS = {
  label: 'known loss',
  remainder: { owner: 'process-exit' },
  settlement: { cause: 'timed-out', budgetMs: 5_000 },
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

function storageHolding(value: unknown): RemainderStorage {
  return storageWith({ [RECORD_PATH]: typeof value === 'string' ? value : JSON.stringify(value) });
}

function classify(storage: RemainderStorage) {
  return classifyShutdownRemainderFile(storage, RECORD_PATH);
}

describe('shutdown remainder writer', () => {
  it('publishes through a writer-owned stage at the single version-derived address', () => {
    const storage = storageWith();

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'provider-proxy-lifecycle-fatal',
        mode: 'handoff',
        undischarged: [
          {
            label: 'pending durable launch settlement',
            remainder: { owner: 'process-exit' },
            settlement: { cause: 'timed-out', budgetMs: 5_000 },
          },
        ],
      }),
    ).toEqual({ kind: 'published' });

    expect(SHUTDOWN_REMAINDER_RECORD_NAME).toBe('shutdown-remainder.v1.json');
    expect(RECORD_PATH).toBe('/run/shutdown-remainder.v1.json');
    expect(STAGE_PATH).toBe('/run/shutdown-remainder.v1.json.stage.4242.unobserved');
    expect(storage.mkdirSync).toHaveBeenCalledWith(RUN_DIR, { recursive: true });
    expect(storage.writeAtomicSync).toHaveBeenCalledWith(
      STAGE_PATH,
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
              settlement: { cause: 'timed-out', budgetMs: 5_000 },
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
    expect(storage.writeAtomicDurableSync).not.toHaveBeenCalled();
    expect(storage.paths()).toEqual([RECORD_PATH]);
  });

  it('names the stage after its writer incarnation when one was observed', () => {
    const incarnation = testIncarnation('observed-writer');

    expect(shutdownRemainderStagePath(RUN_DIR, { pid: 7, incarnation })).toBe(
      `${RECORD_PATH}.stage.7.${sha256Hex(incarnation)}`,
    );
  });

  it.each(['', 'forged\ninstance', 'has spaces', 'A'.repeat(129)])(
    'refuses to write a record for an instanceId outside the closed identifier charset (%j)',
    (instanceId) => {
      const storage = storageWith();

      expect(() =>
        recordShutdownRemainder(writeRuntime(storage), {
          instanceId,
          reason: 'sigterm',
          mode: 'handoff',
          undischarged: [KNOWN_LOSS],
        }),
      ).toThrow(/instanceId/u);
      expect(storage.writeAtomicSync).not.toHaveBeenCalled();
      expect(storage.paths()).toEqual([]);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'refuses to write a record for a writer pid that is not a positive safe integer (%j)',
    (pid) => {
      const storage = storageWith();

      expect(() =>
        recordShutdownRemainder(
          { ...writeRuntime(storage), writer: { pid, incarnation: null } },
          { instanceId: 'current-instance', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
        ),
      ).toThrow(/pid/u);
      expect(storage.writeAtomicSync).not.toHaveBeenCalled();
      expect(storage.paths()).toEqual([]);
    },
  );

  it('overwrites a prior corrupt record without reading it', () => {
    const storage = storageWith({ [RECORD_PATH]: '{not-json' });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toEqual({ kind: 'published' });

    expect(storage.readFileSync).not.toHaveBeenCalled();
    expect(storage.paths()).toEqual([RECORD_PATH]);
    expect(JSON.parse(storage.read(RECORD_PATH) ?? '')).toEqual(recordAt('current-instance'));
  });

  it('does not create a record when publication returns false', () => {
    const storage = storageWith({}, { publish: false });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({
      kind: 'refused',
      operation: 'publish',
      code: 'write-returned-false',
      correlation: expect.stringMatching(/^[a-f0-9]{64}$/u),
      diagnostic: { kind: 'unknown', message: 'record publication returned false' },
    });
    expect(storage.paths()).toEqual([]);
  });

  it('removes both writer-owned stage forms when the final publication fails', () => {
    const storage = storageWith({}, { refuseFinalRename: true });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({
      kind: 'refused',
      operation: 'publish',
      code: 'filesystem-operation-failed',
      diagnostic: { message: expect.stringContaining('rename refused') },
    });
    expect(storage.unlinkSync).toHaveBeenCalledWith(STAGE_PATH);
    expect(storage.unlinkSync).toHaveBeenCalledWith(`${STAGE_PATH}.tmp`);
    expect(storage.paths()).toEqual([]);
  });

  it('reports the originating publication failure when stage cleanup also fails', () => {
    const storage = storageWith({}, { refuseFinalRename: true, refuseUnlink: true });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({
      kind: 'refused',
      operation: 'publish',
      code: 'filesystem-operation-failed',
      diagnostic: { message: expect.stringContaining('rename refused') },
    });
    expect(storage.paths()).toEqual([STAGE_PATH]);
  });

  it('accepts a publication whose stage vanished after the canonical address took its own bytes', () => {
    const serialized = `${JSON.stringify(recordAt('current-instance'), null, 2)}\n`;
    const storage = storageWith({}, { replaceStageBeforeFinalRenameWith: serialized });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toEqual({ kind: 'published' });
    expect(storage.read(RECORD_PATH)).toBe(serialized);
  });

  it('refuses a publication whose stage vanished and left canonical bytes that are not its own', () => {
    const storage = storageWith({}, { replaceStageBeforeFinalRenameWith: 'third-party' });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({
      kind: 'refused',
      operation: 'publish',
      code: 'filesystem-operation-failed',
      diagnostic: { message: expect.stringContaining('missing file') },
    });
    expect(storage.read(RECORD_PATH)).toBe('third-party');
  });

  it('reports publication verification as unavailable when the canonical record cannot be read', () => {
    const storage = storageWith(
      {},
      { replaceStageBeforeFinalRenameWith: 'unreadable', refuseReadFor: RECORD_PATH, readErrorCode: 'EACCES' },
    );

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({
      kind: 'verification-unavailable',
      operation: 'verify-publication',
      code: 'filesystem-operation-failed',
      correlation: expect.stringMatching(/^[a-f0-9]{64}$/u),
      diagnostic: { code: 'EACCES' },
    });
  });

  it('never exposes a stage left behind by a crashed writer as the published record', () => {
    const storage = storageWith({ [STAGE_PATH]: JSON.stringify(recordAt('crashed-instance')) });

    expect(STAGE_PATH.startsWith(`${RECORD_PATH}.`)).toBe(true);
    expect(STAGE_PATH).not.toBe(RECORD_PATH);
    expect(classify(storage)).toEqual({ kind: 'vanished' });
  });

  it('strictly round-trips rejected-error prose and its cause chain through the production read', () => {
    const storage = storageWith();
    const error = {
      kind: 'error',
      name: 'Error',
      code: 'OUTER',
      message: 'Please delete ~/.coral and restart.',
      stack: 'Error: Please delete ~/.coral and restart.\n    at shutdown',
      cause: { kind: 'error', name: 'Error', code: 'ENOENT', message: 'executable missing' },
    } as const;
    const undischarged = [
      {
        label: 'hooks.onShutdown',
        remainder: { owner: 'process-exit' },
        settlement: { cause: 'rejected', error },
      },
    ] as const;

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged,
      }),
    ).toEqual({ kind: 'published' });

    expect(classify(storage)).toStrictEqual({
      kind: 'readable',
      record: {
        instanceId: 'current-instance',
        recordedAt: '2026-09-07T00:00:00.000Z',
        reason: 'sigterm',
        mode: 'handoff',
        entries: undischarged.map((entry, index) => ({ ...entry, entryNumber: index + 1 })),
      },
      skippedEntries: [],
    });
  });

  it('round-trips a free-form discuss store subject under a constant obligation label', () => {
    const storage = storageWith();
    const source = `Next step: run coral-cli backend shutdown ${'x'.repeat(200)}`;

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [
          {
            label: 'discuss store dispose',
            subject: { kind: 'discuss-store', source },
            remainder: { owner: 'process-exit' },
            settlement: { cause: 'timed-out', budgetMs: 5_000 },
          },
        ],
      }),
    ).toEqual({ kind: 'published' });

    expect(classify(storage)).toMatchObject({
      kind: 'readable',
      skippedEntries: [],
      record: {
        entries: [{ label: 'discuss store dispose', subject: { kind: 'discuss-store', source } }],
      },
    });
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
    const undischarged = [
      {
        label: 'child termination',
        remainder,
        settlement: { cause: 'timed-out', budgetMs: 5_000 },
      },
    ] as const;

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'test-teardown',
        mode: 'hard',
        undischarged,
      }),
    ).toEqual({ kind: 'published' });

    expect(classify(storage)).toStrictEqual({
      kind: 'readable',
      skippedEntries: [],
      record: {
        instanceId: 'current-instance',
        recordedAt: '2026-09-07T00:00:00.000Z',
        reason: 'test-teardown',
        mode: 'hard',
        entries: undischarged.map((entry, index) => ({ ...entry, entryNumber: index + 1 })),
      },
    });
  });
});

describe('shutdown remainder file classification', () => {
  it('classifies an absent record as vanished', () => {
    expect(classify(storageWith())).toEqual({ kind: 'vanished' });
  });

  it('classifies a lexically present entry whose target read reports ENOENT as unreadable', () => {
    const storage = storageWith(
      { [RECORD_PATH]: JSON.stringify(recordAt('dangling-instance')) },
      { refuseReadFor: RECORD_PATH, readErrorCode: 'ENOENT' },
    );

    expect(classify(storage)).toEqual({ kind: 'unreadable' });
  });

  it('classifies an ENOENT read whose lexical metadata is itself unobservable as unreadable', () => {
    const storage = storageWith(
      {},
      { refuseReadFor: RECORD_PATH, readErrorCode: 'ENOENT', refuseLstatFor: RECORD_PATH, lstatErrorCode: 'EACCES' },
    );

    expect(classify(storage)).toEqual({ kind: 'unreadable' });
  });

  it('classifies a refused read as unreadable', () => {
    const storage = storageWith({}, { refuseReadFor: RECORD_PATH, readErrorCode: 'EIO' });

    expect(classify(storage)).toEqual({ kind: 'unreadable' });
  });

  it('classifies non-JSON content as corrupt', () => {
    expect(classify(storageHolding('{not-json'))).toEqual({ kind: 'corrupt' });
  });

  it('classifies a shape this build cannot decode as unsupported and names the detail', () => {
    expect(classify(storageHolding({ instanceId: 'foreign-instance', shape: 'unknown-to-this-build' }))).toEqual({
      kind: 'unsupported',
      detail: expect.any(String),
    });
  });

  it.each([
    ['instance id', { instanceId: 'forged\ninstance' }],
    ['reason', { reason: 'forged\nreason' }],
    ['mode', { mode: 'unknown-mode' }],
    ['recorded timestamp', { recordedAt: 'not-a-timestamp' }],
    ['entries', { entries: 'not-an-array' }],
  ])('refuses a record whose known %s field is invalid instead of tolerating it', (_field, override) => {
    expect(classify(storageHolding({ ...recordAt('bounded-instance'), ...override }))).toMatchObject({
      kind: 'unsupported',
    });
  });

  it('keeps raw-name identity distinct when terminal labels require escaping or truncation', () => {
    const escaped = shutdownRemainderFilesystemSubject('same\n.json');
    const replacement = shutdownRemainderFilesystemSubject('same�.json');
    const longA = shutdownRemainderFilesystemSubject(`${'x'.repeat(4096)}a`);
    const longB = shutdownRemainderFilesystemSubject(`${'x'.repeat(4096)}b`);

    expect(escaped).toEqual({ identity: sha256Hex('same\n.json'), label: 'same\\u{A}.json' });
    expect(replacement).toEqual({ identity: sha256Hex('same�.json'), label: 'same�.json' });
    expect(escaped.identity).not.toBe(replacement.identity);
    expect(escaped.label).not.toBe(replacement.label);
    expect(longA.identity).not.toBe(longB.identity);
    expect(longA.label).not.toBe(longB.label);
    expect(longA.label).toHaveLength(4096);
    expect(longB.label).toHaveLength(4096);
  });
});

describe('shutdown remainder entry decoding', () => {
  it('skips an unknown successor evidence kind without rejecting readable entries', () => {
    const storage = storageHolding({
      ...recordAt('future-instance'),
      reason: 'provider-proxy-lifecycle-fatal',
      entries: [
        {
          label: 'future successor',
          remainder: {
            owner: 'successor-recovery',
            evidence: { kind: 'future-recovery', durableKey: 'future-key' },
          },
          settlement: { cause: 'unconfirmed', detail: 'future recovery owns this' },
        },
        KNOWN_LOSS,
      ],
    });

    const classification = classify(storage);
    expect(classification).toMatchObject({
      kind: 'readable',
      skippedEntries: [
        {
          recordInstanceId: 'future-instance',
          entryNumber: 1,
          label: 'future successor',
          owner: 'successor-recovery',
        },
      ],
    });
    expect(classification.kind === 'readable' ? classification.record.entries : []).toEqual([
      { ...KNOWN_LOSS, entryNumber: 2 },
    ]);
  });

  it('counts malformed entries while retaining the rest of their record', () => {
    const storage = storageHolding({
      ...recordAt('malformed-instance'),
      entries: [
        {
          ...KNOWN_LOSS,
          settlement: { cause: 'rejected', error: { kind: 'error', name: 'Error', message: 'known detail' } },
        },
        { ...KNOWN_LOSS, label: 'legacy timeout', settlement: { cause: 'timed-out', detail: 'known detail' } },
        { label: 'missing settlement', remainder: { owner: 'process-exit' } },
        'not-an-entry',
      ],
    });

    const classification = classify(storage);
    expect(classification).toMatchObject({
      kind: 'readable',
      skippedEntries: [
        { recordInstanceId: 'malformed-instance', entryNumber: 2, label: 'legacy timeout', owner: 'process-exit' },
        { recordInstanceId: 'malformed-instance', entryNumber: 3, label: 'missing settlement', owner: 'process-exit' },
        { recordInstanceId: 'malformed-instance', entryNumber: 4, label: null, owner: null },
      ],
    });
    expect(classification.kind === 'readable' ? classification.record.entries : []).toHaveLength(1);
  });

  it('rejects multiline entry labels without carrying them into skipped-entry output', () => {
    const storage = storageHolding({
      ...recordAt('bounded-instance'),
      entries: [{ ...KNOWN_LOSS, label: 'forged\nline' }],
    });

    expect(classify(storage)).toMatchObject({
      kind: 'readable',
      record: { instanceId: 'bounded-instance', entries: [] },
      skippedEntries: [{ recordInstanceId: 'bounded-instance', entryNumber: 1, label: null, owner: 'process-exit' }],
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
        budgetMs: 5_000,
        settlementAddition: true,
      },
    };
    const storage = storageHolding({
      ...recordAt('older-instance', [additiveEntry]),
      envelopeAddition: true,
    });

    expect(classify(storage)).toStrictEqual({
      kind: 'readable',
      record: {
        ...recordAt('older-instance', []),
        entries: [
          {
            entryNumber: 1,
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
            settlement: { cause: 'timed-out', budgetMs: 5_000 },
          },
        ],
      },
      skippedEntries: [],
    });
  });

  it('accepts additive envelope, entry, and recursive error-cause keys while validating known fields', () => {
    const storage = storageHolding({
      ...recordAt('additive-canary'),
      envelopeAddition: true,
      entries: [
        {
          ...KNOWN_LOSS,
          entryAddition: true,
          settlement: {
            cause: 'rejected',
            error: {
              kind: 'error',
              name: 'Error',
              message: 'outer',
              cause: {
                kind: 'error',
                name: 'TypeError',
                message: 'inner',
                causeAddition: true,
              },
            },
          },
        },
        {
          ...KNOWN_LOSS,
          label: 'invalid recursive known field',
          settlement: {
            cause: 'rejected',
            error: {
              kind: 'error',
              name: 'Error',
              message: 'outer',
              cause: { kind: 'error', name: 'TypeError', message: 42, causeAddition: true },
            },
          },
        },
      ],
    });

    expect(classify(storage)).toMatchObject({
      kind: 'readable',
      record: {
        instanceId: 'additive-canary',
        entries: [
          {
            entryNumber: 1,
            label: 'known loss',
            settlement: {
              cause: 'rejected',
              error: {
                kind: 'error',
                name: 'Error',
                message: 'outer',
                cause: { kind: 'error', name: 'TypeError', message: 'inner' },
              },
            },
          },
        ],
      },
      skippedEntries: [
        {
          recordInstanceId: 'additive-canary',
          entryNumber: 2,
          label: 'invalid recursive known field',
          owner: 'process-exit',
        },
      ],
    });
  });

  it.each([
    ['envelope', () => ({ envelopeAddition: true }), () => KNOWN_LOSS],
    ['entry', () => ({}), () => ({ ...KNOWN_LOSS, entryAddition: true })],
    [
      'subject',
      () => ({}),
      () => ({ ...KNOWN_LOSS, subject: { kind: 'discuss-store', source: 'source', subjectAddition: true } }),
    ],
    [
      'process-exit remainder',
      () => ({}),
      () => ({ ...KNOWN_LOSS, remainder: { owner: 'process-exit', remainderAddition: true } }),
    ],
    [
      'successor-recovery remainder',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        remainder: {
          owner: 'successor-recovery',
          remainderAddition: true,
          evidence: { kind: 'startup-store-recovery' },
        },
      }),
    ],
    [
      'startup-adoption evidence',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        remainder: {
          owner: 'successor-recovery',
          evidence: { kind: 'startup-adoption', evidenceAddition: true, processes: [] },
        },
      }),
    ],
    [
      'startup-adoption process',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        remainder: {
          owner: 'successor-recovery',
          evidence: {
            kind: 'startup-adoption',
            processes: [
              {
                kind: 'durable-cli-runtime',
                jobId: 'job-1',
                pid: 4_242,
                leaderIncarnation: testIncarnation('canary-process'),
                processAddition: true,
              },
            ],
          },
        },
      }),
    ],
    [
      'startup-store-recovery evidence',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        remainder: {
          owner: 'successor-recovery',
          evidence: { kind: 'startup-store-recovery', evidenceAddition: true },
        },
      }),
    ],
    [
      'startup-liveness-recovery evidence',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        remainder: {
          owner: 'successor-recovery',
          evidence: { kind: 'startup-liveness-recovery', evidenceAddition: true },
        },
      }),
    ],
    [
      'rejected settlement',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        settlement: {
          cause: 'rejected',
          settlementAddition: true,
          error: { kind: 'error', name: 'Error', message: 'failed' },
        },
      }),
    ],
    [
      'aborted settlement',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        settlement: {
          cause: 'aborted',
          settlementAddition: true,
          error: { kind: 'error', name: 'Error', message: 'aborted' },
        },
      }),
    ],
    [
      'timed-out settlement',
      () => ({}),
      () => ({ ...KNOWN_LOSS, settlement: { cause: 'timed-out', budgetMs: 5_000, settlementAddition: true } }),
    ],
    [
      'budget-exhausted settlement',
      () => ({}),
      () => ({ ...KNOWN_LOSS, settlement: { cause: 'budget-exhausted', settlementAddition: true } }),
    ],
    [
      'unconfirmed settlement',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        settlement: { cause: 'unconfirmed', detail: 'still pending', settlementAddition: true },
      }),
    ],
    [
      'serialized error',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        settlement: {
          cause: 'rejected',
          error: {
            kind: 'error',
            name: 'Error',
            message: 'outer',
            errorAddition: true,
            cause: { kind: 'error', name: 'TypeError', message: 'inner', recursiveAddition: true },
          },
        },
      }),
    ],
    [
      'serialized unknown',
      () => ({}),
      () => ({
        ...KNOWN_LOSS,
        settlement: {
          cause: 'rejected',
          error: { kind: 'unknown', message: 'unknown failure', unknownAddition: true },
        },
      }),
    ],
  ] as const)('accepts additive keys at the %s persisted object boundary', (_boundary, envelopeAddition, entry) => {
    const storage = storageHolding({
      ...recordAt('branch-complete-canary', [entry()]),
      ...envelopeAddition(),
    });

    const classification = classify(storage);

    expect(classification.kind).toBe('readable');
    expect(classification.kind === 'readable' ? classification.record.entries : []).toHaveLength(1);
    expect(classification.kind === 'readable' ? classification.skippedEntries : ['unexpected']).toEqual([]);
  });
});
