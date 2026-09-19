import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  pruneShutdownRemainderRecords,
  recordShutdownRemainder,
  shutdownRemainderPath,
} from '#src/coordinator/shutdown-remainder.js';
import {
  observeShutdownRemainderStageWriter,
  scanShutdownRemainderRecords,
} from '#src/infra/shutdown-remainder-record.js';
import { sha256Hex } from '#src/infra/hash.js';
import { childTerminationRemainder } from '#src/coordinator/shutdown.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const RUN_DIR = '/run';
const REMAINDER_DIRECTORY = '/run/shutdown-remainder.v1';

type RemainderStorage = Pick<
  StoragePort,
  | 'existsSync'
  | 'mkdirSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'renameSync'
  | 'statSync'
  | 'unlinkSync'
  | 'writeAtomicSync'
  | 'writeAtomicDurableSync'
> & {
  fileNames(): string[];
  readPublished(instanceId: string): string | null;
};

type InitialFile = Readonly<{ name: string; value: string; mtimeMs: number }>;

function storageWith(
  initialFiles: readonly InitialFile[] = [],
  options: Readonly<{
    publish?: boolean;
    refusePrune?: boolean;
    refuseStatFor?: string;
    statErrorCode?: string;
    refuseReadFor?: string | readonly string[];
    readErrorCode?: string;
    pruneBeforeAtomicRename?: boolean;
    refuseFinalRename?: boolean;
  }> = {},
): RemainderStorage {
  const files = new Map(
    initialFiles.map(({ name, value, mtimeMs }) => [join(REMAINDER_DIRECTORY, name), { value, mtimeMs }]),
  );
  let directoryExists = initialFiles.length > 0;
  let clock = Math.max(0, ...initialFiles.map(({ mtimeMs }) => mtimeMs));
  const refusedReadNames = new Set(
    options.refuseReadFor === undefined
      ? []
      : typeof options.refuseReadFor === 'string'
        ? [options.refuseReadFor]
        : options.refuseReadFor,
  );

  const storage = {
    existsSync: (path: string) => (path === REMAINDER_DIRECTORY ? directoryExists : files.has(path)),
    readdirSync: vi.fn((path: string) => {
      if (path !== REMAINDER_DIRECTORY || !directoryExists) throw new Error('missing directory');
      return [...files.keys()].filter((file) => dirname(file) === path).map((file) => basename(file));
    }) as unknown as StoragePort['readdirSync'],
    readFileSync: vi.fn((path: string) => {
      if (refusedReadNames.has(basename(path))) {
        throw Object.assign(new Error('read refused'), { code: options.readErrorCode ?? 'EIO' });
      }
      const file = files.get(path);
      if (file === undefined) throw new Error('missing file');
      return file.value;
    }) as StoragePort['readFileSync'],
    statSync: vi.fn((path: string) => {
      if (basename(path) === options.refuseStatFor) {
        throw Object.assign(new Error('stat refused'), { code: options.statErrorCode ?? 'EIO' });
      }
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
    mkdirSync: vi.fn(() => {
      directoryExists = true;
    }),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      if (options.refuseFinalRename === true && newPath.endsWith('.json')) {
        throw Object.assign(new Error('rename refused'), { code: 'EIO' });
      }
      const file = files.get(oldPath);
      if (file === undefined) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      files.delete(oldPath);
      files.set(newPath, file);
    }),
    writeAtomicSync: vi.fn((path: string, data: string | NodeJS.ArrayBufferView) => {
      if (options.publish === false) return false;
      const value =
        typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
      const tempPath = `${path}.tmp`;
      files.set(tempPath, { value, mtimeMs: ++clock });
      if (options.pruneBeforeAtomicRename === true) {
        pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR, observeStageWriter: () => 'alive' });
      }
      storage.renameSync(tempPath, path);
      return true;
    }),
    writeAtomicDurableSync: vi.fn(() => options.publish !== false),
    fileNames: () => [...files.keys()].map((file) => basename(file)).sort(),
    readPublished: (instanceId: string) => files.get(join(REMAINDER_DIRECTORY, `${instanceId}.json`))?.value ?? null,
  } satisfies RemainderStorage;

  return storage;
}

function writeRuntime(storage: RemainderStorage) {
  return {
    storage,
    time: { now: () => 1_788_739_200_000 },
    runDir: RUN_DIR,
    writer: { pid: 4_242 },
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

function decodedRecordAt(instanceId: string) {
  return recordAt(instanceId, [{ ...KNOWN_LOSS, entryNumber: 1 }]);
}

function fileAt(instanceId: string, mtimeMs: number, value: unknown = recordAt(instanceId)): InitialFile {
  return { name: `${instanceId}.json`, value: JSON.stringify(value), mtimeMs };
}

describe('shutdown remainder status', () => {
  it('distinguishes an exact live writer from an absent or unobservable stage writer', () => {
    const incarnation = testIncarnation('stage-writer');
    const writer = { pid: 4_242, incarnationDigest: sha256Hex(incarnation) };

    expect(
      observeShutdownRemainderStageWriter(writer, {
        platform: 'linux',
        observeLiveness: () => 'unknown',
        readProcessIncarnation: () => incarnation,
      }),
    ).toBe('alive');
    expect(
      observeShutdownRemainderStageWriter(writer, {
        platform: 'linux',
        observeLiveness: () => 'alive',
        readProcessIncarnation: () => testIncarnation('recycled-pid'),
      }),
    ).toBe('absent');
    expect(
      observeShutdownRemainderStageWriter(
        { pid: 4_242 },
        {
          platform: 'linux',
          observeLiveness: () => 'alive',
          readProcessIncarnation: () => null,
        },
      ),
    ).toBe('unknown');
    expect(
      observeShutdownRemainderStageWriter(
        { pid: 4_242 },
        {
          platform: 'linux',
          observeLiveness: () => 'absent',
          readProcessIncarnation: () => null,
        },
      ),
    ).toBe('absent');
  });

  it('creates the version directory and avoids a durable journal wait while publishing the record', () => {
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
    ).toBe(true);

    expect(shutdownRemainderPath(RUN_DIR)).toBe(REMAINDER_DIRECTORY);
    expect(storage.mkdirSync).toHaveBeenCalledWith(REMAINDER_DIRECTORY, { recursive: true });
    expect(storage.writeAtomicSync).toHaveBeenCalledWith(
      '/run/shutdown-remainder.v1/current-instance.json.stage.4242.unknown',
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
      expect(storage.fileNames()).toEqual([]);
    },
  );

  it('strictly round-trips rejected-error prose and its cause chain in the private record', () => {
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
    ).toBe(true);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toStrictEqual({
      records: [
        {
          instanceId: 'current-instance',
          recordedAt: '2026-09-07T00:00:00.000Z',
          reason: 'sigterm',
          mode: 'handoff',
          entries: undischarged.map((entry, index) => ({ ...entry, entryNumber: index + 1 })),
        },
      ],
      skippedEntries: [],
      skippedRecords: [],
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
    ).toBe(true);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      skippedEntries: [],
      records: [
        {
          entries: [
            {
              label: 'discuss store dispose',
              subject: { kind: 'discuss-store', source },
            },
          ],
        },
      ],
    });
  });

  it('skips an unknown successor evidence kind without rejecting readable entries', () => {
    const storage = storageWith([
      fileAt('future-instance', 1, {
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
      }),
    ]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toEqual({
      records: [
        {
          ...recordAt('future-instance', [{ ...KNOWN_LOSS, entryNumber: 2 }]),
          reason: 'provider-proxy-lifecycle-fatal',
        },
      ],
      skippedEntries: [
        {
          recordInstanceId: 'future-instance',
          entryNumber: 1,
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
          {
            ...KNOWN_LOSS,
            settlement: { cause: 'rejected', error: { kind: 'error', name: 'Error', message: 'known detail' } },
          },
          { ...KNOWN_LOSS, label: 'legacy timeout', settlement: { cause: 'timed-out', detail: 'known detail' } },
          { label: 'missing settlement', remainder: { owner: 'process-exit' } },
          'not-an-entry',
        ],
      }),
    ]);

    const read = scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY);
    expect(read).toMatchObject({
      skippedEntries: [
        {
          recordInstanceId: 'malformed-instance',
          entryNumber: 2,
          label: 'legacy timeout',
          owner: 'process-exit',
        },
        {
          recordInstanceId: 'malformed-instance',
          entryNumber: 3,
          label: 'missing settlement',
          owner: 'process-exit',
        },
        {
          recordInstanceId: 'malformed-instance',
          entryNumber: 4,
          label: null,
          owner: null,
        },
      ],
      skippedRecords: [],
    });
    expect(read.records[0]?.entries).toHaveLength(1);
  });

  it('rejects multiline entry labels without carrying them into skipped-entry output', () => {
    const storage = storageWith([
      fileAt('bounded-instance', 1, {
        ...recordAt('bounded-instance'),
        entries: [{ ...KNOWN_LOSS, label: 'forged\nline' }],
      }),
    ]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [{ instanceId: 'bounded-instance', entries: [] }],
      skippedEntries: [
        {
          recordInstanceId: 'bounded-instance',
          entryNumber: 1,
          label: null,
          owner: 'process-exit',
        },
      ],
    });
  });

  it.each([
    ['instance id', { ...recordAt('bounded-instance'), instanceId: 'forged\ninstance' }],
    ['reason', { ...recordAt('bounded-instance'), reason: 'forged\nreason' }],
  ])('rejects a record with an invalid single-line %s', (_field, record) => {
    const storage = storageWith([fileAt('bounded-instance', 1, record)]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [],
      skippedRecords: [{ name: 'bounded-instance.json', reason: 'unsupported' }],
    });
  });

  it('reports an unsafe skipped filename through a fixed single-line fact', () => {
    const storage = storageWith([{ name: 'forged\nrecord.json', value: '{not-json', mtimeMs: 1 }]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      skippedRecords: [{ name: 'invalid-record-name', reason: 'corrupt' }],
    });
  });

  it('normalizes a skipped record filename outside the closed identifier charset', () => {
    const storage = storageWith([{ name: 'forged command=rm -rf ~ (danger).json', value: '{not-json', mtimeMs: 1 }]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      skippedRecords: [{ name: 'invalid-record-name', reason: 'corrupt' }],
    });
  });

  it('skips corrupt and unsupported files beside readable records', () => {
    const storage = storageWith([
      fileAt('known-instance', 1),
      { name: 'corrupt-instance.json', value: '{not-json', mtimeMs: 2 },
      fileAt('foreign-instance', 3, { instanceId: 'foreign-instance', shape: 'unknown-to-this-build' }),
      { name: 'ignored.tmp', value: 'not a record', mtimeMs: 4 },
    ]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toEqual({
      records: [decodedRecordAt('known-instance')],
      skippedEntries: [],
      skippedRecords: [
        { name: 'corrupt-instance.json', reason: 'corrupt' },
        { name: 'foreign-instance.json', reason: 'unsupported', detail: expect.any(String) },
      ],
    });
  });

  it('keeps per-record read tolerance when file metadata is unavailable', () => {
    const storage = storageWith([fileAt('known-instance', 1)], { refuseStatFor: 'known-instance.json' });

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [recordAt('known-instance')],
      skippedEntries: [],
      skippedRecords: [],
    });
  });

  it('classifies content when the metadata read fails for a reason other than vanishing', () => {
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refuseStatFor: 'corrupt.json',
      statErrorCode: 'EIO',
    });

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [],
      skippedRecords: [{ name: 'corrupt.json', reason: 'corrupt' }],
    });
  });

  it('omits a record confirmed absent during the directory-to-stat race', () => {
    const storage = storageWith([{ name: 'vanished.json', value: '{not-json', mtimeMs: 1 }], {
      refuseStatFor: 'vanished.json',
      statErrorCode: 'ENOENT',
    });

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [],
      skippedRecords: [],
    });
    expect(storage.readFileSync).not.toHaveBeenCalled();
  });

  it('omits a record confirmed absent during the stat-to-read race, the same as the directory-to-stat race', () => {
    const storage = storageWith([{ name: 'vanished-after-stat.json', value: '{not-json', mtimeMs: 1 }], {
      refuseReadFor: 'vanished-after-stat.json',
      readErrorCode: 'ENOENT',
    });

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [],
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
        budgetMs: 5_000,
        settlementAddition: true,
      },
    };
    const storage = storageWith([
      fileAt('older-instance', 1, {
        ...recordAt('older-instance', [additiveEntry]),
        envelopeAddition: true,
      }),
    ]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toStrictEqual({
      records: [
        {
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
      ],
      skippedEntries: [],
      skippedRecords: [],
    });
  });

  it('accepts additive envelope, entry, and recursive error-cause keys while validating known fields', () => {
    const storage = storageWith([
      fileAt('additive-canary', 1, {
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
      }),
    ]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [
        {
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
      ],
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

  it('overwrites the same instance without reading a corrupt prior record', () => {
    const storage = storageWith([{ name: 'current-instance.json', value: '{not-json', mtimeMs: 1 }]);

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toBe(true);

    expect(storage.readFileSync).not.toHaveBeenCalled();
    expect(storage.fileNames()).toEqual(['current-instance.json']);
    expect(JSON.parse(storage.readPublished('current-instance') ?? '')).toEqual(recordAt('current-instance'));
  });

  it('prunes the successor-visible directory to the newest 32 instance files by mtime', () => {
    const storage = storageWith(Array.from({ length: 32 }, (_, index) => fileAt(`instance-${index}`, index + 1)));

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'instance-32',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toBe(true);

    expect(storage.fileNames()).toHaveLength(33);
    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });
    expect(storage.fileNames()).toHaveLength(32);
    expect(storage.fileNames()).not.toContain('instance-0.json');
    expect(storage.fileNames()).toContain('instance-32.json');
  });

  it('does not delete a record it cannot stat while the retention cap is not exceeded', () => {
    const storage = storageWith([fileAt('readable', 1), fileAt('unstattable', 2)], {
      refuseStatFor: 'unstattable.json',
      statErrorCode: 'EIO',
    });

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toEqual(['readable.json', 'unstattable.json']);
  });

  it('reclaims an unstattable-but-readable record as the oldest entry once the known bucket exceeds the cap', () => {
    const storage = storageWith(
      [...Array.from({ length: 32 }, (_, index) => fileAt(`instance-${index}`, index + 1)), fileAt('unstattable', 33)],
      { refuseStatFor: 'unstattable.json', statErrorCode: 'EIO' },
    );

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    // A decodable record with no age evidence is not exempt from the bound its readable content would
    // otherwise compete under (design-philosophy.md principle 11) — it joins the known bucket ranked as the
    // oldest entry, so it is the one reclaimed once that bucket exceeds the cap, even though its real mtime
    // (33) is the newest of the group.
    expect(storage.fileNames()).toHaveLength(32);
    expect(storage.fileNames()).not.toContain('unstattable.json');
    expect(storage.fileNames()).toContain('instance-0.json');
    expect(storage.fileNames()).toContain('instance-31.json');
  });

  it('prunes the oldest known record and an unstattable record together once they exceed the cap', () => {
    const storage = storageWith(
      [...Array.from({ length: 33 }, (_, index) => fileAt(`instance-${index}`, index + 1)), fileAt('unstattable', 34)],
      { refuseStatFor: 'unstattable.json', statErrorCode: 'EIO' },
    );

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    // The unstattable record competes in the same bucket as every other decodable record, ranked as its
    // oldest entry (see the previous test); with 34 entries against the 32-slot cap, it and the next-oldest
    // known record by real mtime are both reclaimed.
    expect(storage.fileNames()).toHaveLength(32);
    expect(storage.fileNames()).not.toContain('unstattable.json');
    expect(storage.fileNames()).not.toContain('instance-0.json');
    expect(storage.fileNames()).toContain('instance-1.json');
    expect(storage.fileNames()).toContain('instance-32.json');
  });

  it('prunes only the oldest known records once they exceed the cap, leaving an unreadable record untouched', () => {
    const storage = storageWith(
      [...Array.from({ length: 33 }, (_, index) => fileAt(`instance-${index}`, index + 1)), fileAt('unreadable', 34)],
      { refuseReadFor: 'unreadable.json', readErrorCode: 'EIO' },
    );

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toHaveLength(33);
    expect(storage.fileNames()).toContain('unreadable.json');
    expect(storage.fileNames()).not.toContain('instance-0.json');
    expect(storage.fileNames()).toContain('instance-32.json');
  });

  it('bounds unreadable records to the newest 32 by mtime, independent of the known-record cap', () => {
    const unreadableFiles = Array.from({ length: 33 }, (_, index) => fileAt(`unreadable-${index}`, index + 1));
    const storage = storageWith([fileAt('readable', 100), ...unreadableFiles], {
      refuseReadFor: unreadableFiles.map(({ name }) => name),
      readErrorCode: 'EIO',
    });

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    // A genuine unknown never authorizes deletion by content (design-philosophy.md principle 11), but this
    // hold still needs an exit (principle 11/12): the oldest unreadable file is reclaimed once the bucket
    // exceeds its own 32-slot bound, the same bound the known-record cap uses, in an independent bucket that
    // cannot displace — and is not displaced by — a genuinely readable record.
    expect(storage.fileNames()).toHaveLength(33);
    expect(storage.fileNames()).toContain('readable.json');
    expect(storage.fileNames()).not.toContain('unreadable-0.json');
    expect(storage.fileNames()).toContain('unreadable-32.json');
  });

  it('reclaims an unreadable record with no stat evidence once its bucket exceeds the retention bound', () => {
    const knownUnreadableFiles = Array.from({ length: 32 }, (_, index) => fileAt(`unreadable-${index}`, index + 1));
    const storage = storageWith(
      [fileAt('readable', 100), ...knownUnreadableFiles, fileAt('unreadable-unstattable', 33)],
      {
        refuseReadFor: [...knownUnreadableFiles.map(({ name }) => name), 'unreadable-unstattable.json'],
        readErrorCode: 'EIO',
        refuseStatFor: 'unreadable-unstattable.json',
        statErrorCode: 'EACCES',
      },
    );

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    // A file this build could not even stat carries no age evidence, but it still competes for the same
    // 32-slot unreadable bound (design-philosophy.md principle 11/12) — ranked as the oldest, so it is the one
    // reclaimed once the bucket exceeds that bound, rather than being exempted from the bound entirely.
    expect(storage.fileNames()).toHaveLength(33);
    expect(storage.fileNames()).toContain('readable.json');
    expect(storage.fileNames()).not.toContain('unreadable-unstattable.json');
    expect(storage.fileNames()).toContain('unreadable-0.json');
    expect(storage.fileNames()).toContain('unreadable-31.json');
  });

  it('reclaims a decisively corrupt record regardless of age, even under the retention cap', () => {
    const storage = storageWith([fileAt('readable', 1), { name: 'corrupt.json', value: '{not-json', mtimeMs: 2 }]);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toEqual(['readable.json']);
  });

  it('holds an unsupported record under bounded retention instead of deleting it outright', () => {
    // The rollback case design-philosophy.md principle 10 asks every durable shape to fail softly against: a
    // schema this build's own `z.enum` rejects (an unrecognized `reason`/`mode` a newer build wrote) proves
    // nothing about whether some other build could still decode the same bytes, so the prune must not treat it
    // the way it treats a genuinely corrupt file.
    const storage = storageWith([
      fileAt('readable', 1),
      {
        name: 'future-instance.json',
        value: JSON.stringify({
          ...recordAt('future-instance'),
          reason: 'a-seventh-shutdown-reason-this-build-does-not-know',
        }),
        mtimeMs: 2,
      },
    ]);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames().sort()).toEqual(['future-instance.json', 'readable.json']);
    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [recordAt('readable')],
      skippedRecords: [{ name: 'future-instance.json', reason: 'unsupported' }],
    });
  });

  it('reclaims an unsupported record once its own bucket exceeds the retention bound, independent of known and unreadable', () => {
    const unsupportedFiles = Array.from({ length: 33 }, (_, index) => ({
      name: `unsupported-${index}.json`,
      value: JSON.stringify({ ...recordAt(`unsupported-${index}`), reason: 'a-future-shutdown-reason' }),
      mtimeMs: index + 1,
    }));
    const storage = storageWith([fileAt('readable', 100), ...unsupportedFiles]);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toHaveLength(33);
    expect(storage.fileNames()).toContain('readable.json');
    expect(storage.fileNames()).not.toContain('unsupported-0.json');
    expect(storage.fileNames()).toContain('unsupported-32.json');
  });

  it('does not unlink a live atomic-write staging file when prune runs before rename', () => {
    const storage = storageWith([], { pruneBeforeAtomicRename: true });

    expect(
      recordShutdownRemainder(
        { ...writeRuntime(storage), writer: { pid: 4_242, incarnation: testIncarnation('live-writer') } },
        { instanceId: 'current-instance', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toBe(true);

    expect(storage.fileNames()).toEqual(['current-instance.json']);
    expect(JSON.parse(storage.readPublished('current-instance') ?? '')).toEqual(recordAt('current-instance'));
  });

  it('promotes a complete stage only after its writer is proven absent', () => {
    const stageName = 'orphan.json.stage.4242.unknown';
    const storage = storageWith([{ name: stageName, value: JSON.stringify(recordAt('orphan')), mtimeMs: 1 }]);

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => 'absent',
    });

    expect(disposition).toEqual({ kind: 'stage-ownership-classified' });
    expect(storage.fileNames()).toEqual(['orphan.json']);
    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [recordAt('orphan')],
      skippedRecords: [],
    });
  });

  it('returns an ownership hold when a stage writer is unobservable', () => {
    const stageName = 'held.json.stage.4242.unknown';
    const storage = storageWith([{ name: stageName, value: JSON.stringify(recordAt('held')), mtimeMs: 1 }]);

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => 'unknown',
    });

    expect(disposition).toEqual({ kind: 'stage-ownership-held', stageNames: [stageName] });
    expect(storage.fileNames()).toEqual([stageName]);
  });

  it('bounds proven-orphan partial stages independently and reports every retained stage', () => {
    const stages = Array.from({ length: 40 }, (_, index) => ({
      name: `orphan-${index}.json.stage.${5_000 + index}.unknown.tmp`,
      value: '{partial',
      mtimeMs: index + 1,
    }));
    const storage = storageWith(stages);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR, observeStageWriter: () => 'absent' });
    const scan = scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY, () => 'absent');

    expect(storage.fileNames()).toHaveLength(32);
    expect(storage.fileNames()).not.toContain(stages[0]?.name);
    expect(storage.fileNames()).toContain(stages[39]?.name);
    expect(scan.records).toEqual([]);
    expect(scan.skippedRecords).toHaveLength(32);
    expect(scan.skippedRecords.every(({ reason }) => reason === 'orphaned-staging')).toBe(true);
  });

  it('removes both writer-owned stage forms when final publication fails', () => {
    const storage = storageWith([], { refuseFinalRename: true });

    expect(() =>
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toThrow('rename refused');
    expect(storage.fileNames()).toEqual([]);
  });

  it('does not turn a best-effort startup prune refusal into an error', () => {
    const storage = storageWith(
      Array.from({ length: 32 }, (_, index) => fileAt(`instance-${index}`, index + 1)),
      { refusePrune: true },
    );

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'instance-32',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toBe(true);
    expect(() => pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR })).not.toThrow();
    expect(storage.fileNames()).toHaveLength(33);
  });

  it('does not create a new record file when publication is refused', () => {
    const storage = storageWith([fileAt('existing-instance', 1)], { publish: false });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toBe(false);
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
    ).toBe(true);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toStrictEqual({
      skippedEntries: [],
      skippedRecords: [],
      records: [
        {
          instanceId: 'current-instance',
          recordedAt: '2026-09-07T00:00:00.000Z',
          reason: 'test-teardown',
          mode: 'hard',
          entries: undischarged.map((entry, index) => ({ ...entry, entryNumber: index + 1 })),
        },
      ],
    });
  });
});
