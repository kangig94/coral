import { basename, dirname, join, relative } from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import {
  createShutdownRemainderPruner,
  pruneShutdownRemainderRecords,
  recordShutdownRemainder,
} from '#src/coordinator/shutdown-remainder.js';
import {
  observeShutdownRemainderStageWriter,
  scanShutdownRemainderRecords,
  SHUTDOWN_REMAINDER_SCAN_LIMIT,
  shutdownRemainderFilesystemSubject,
  shutdownRemainderRecordDirectory,
} from '#src/infra/shutdown-remainder-record.js';
import { sha256Hex } from '#src/infra/hash.js';
import { childTerminationRemainder } from '#src/coordinator/shutdown.js';
import type { StoragePath, StoragePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const RUN_DIR = '/run';
const REMAINDER_DIRECTORY = '/run/shutdown-remainder.v1';
const SCHEDULED_SNAPSHOT_METADATA = {
  overflowedRefusalCount: 0,
  observedAt: null,
  retry: { state: 'scheduled', owner: 'coordinator' },
} as const;

type RemainderStorage = Pick<
  StoragePort,
  | 'mkdirSync'
  | 'lstatSync'
  | 'readFileSync'
  | 'readDirectoryBoundedSync'
  | 'readdirSync'
  | 'renameSync'
  | 'statSync'
  | 'unlinkSync'
  | 'writeAtomicSync'
  | 'writeAtomicDurableSync'
> & {
  fileNames(): string[];
  readFile(name: string): string | null;
  readPublished(instanceId: string): string | null;
};

type InitialFile = Readonly<{ name: string; value: string; mtimeMs: number }>;

function storageWith(
  initialFiles: readonly InitialFile[] = [],
  options: Readonly<{
    publish?: boolean;
    refusePrune?: boolean;
    refusePruneWhen?: (name: string, attempt: number) => boolean;
    disappearDuringPruneWhen?: (name: string, attempt: number) => boolean;
    pruneErrorCode?: string;
    refuseStatFor?: string;
    statErrorCode?: string;
    refuseLstatFor?: string;
    lstatErrorCode?: string;
    refuseReadFor?: string | readonly string[];
    refuseReadWhen?: (name: string, attempt: number) => boolean;
    readErrorCode?: string;
    refuseReaddirWhen?: (path: string, attempt: number) => boolean;
    pruneBeforeAtomicRename?: boolean;
    publishStageBeforeFinalRename?: boolean;
    replaceStageBeforeFinalRenameWith?: string;
    publishDuringPruneRename?: boolean;
    refuseAtomicRename?: boolean;
    refuseFinalRename?: boolean;
    maxComponentBytes?: number;
  }> = {},
): RemainderStorage {
  let nextIno = 1n;
  const files = new Map(
    initialFiles.map(({ name, value, mtimeMs }) => [
      join(REMAINDER_DIRECTORY, name),
      { value, mtimeMs, ino: nextIno++ },
    ]),
  );
  const directories = new Set(initialFiles.length > 0 ? [REMAINDER_DIRECTORY] : []);
  let clock = Math.max(0, ...initialFiles.map(({ mtimeMs }) => mtimeMs));
  const refusedReadNames = new Set(
    options.refuseReadFor === undefined
      ? []
      : typeof options.refuseReadFor === 'string'
        ? [options.refuseReadFor]
        : options.refuseReadFor,
  );
  const pruneAttempts = new Map<string, number>();
  const readAttempts = new Map<string, number>();
  let readdirAttempts = 0;
  let stagePublishedBeforeFinalRename = false;
  let stagePublishedDuringPruneRename = false;

  const storage = {
    readdirSync: vi.fn((path: string, readdirOptions?: { encoding: 'buffer' }) => {
      readdirAttempts += 1;
      if (options.refuseReaddirWhen?.(path, readdirAttempts) === true) {
        throw Object.assign(new Error('directory read refused'), { code: 'EIO' });
      }
      if (!directories.has(path)) throw Object.assign(new Error('missing directory'), { code: 'ENOENT' });
      const names = [
        ...new Set(
          [...directories, ...files.keys()]
            .filter((entry) => entry !== path && dirname(entry) === path)
            .map((entry) => basename(entry)),
        ),
      ];
      return readdirOptions?.encoding === 'buffer' ? names.map((name) => Buffer.from(name)) : names;
    }) as unknown as StoragePort['readdirSync'],
    readDirectoryBoundedSync: vi.fn((path: string, limit: number, options?: { encoding: 'buffer' }) => {
      const names = storage.readdirSync(path);
      return options === undefined
        ? { entries: names.slice(0, limit), overflow: names.length > limit }
        : {
            entries: names.slice(0, limit).map((name) => Buffer.from(name)),
            overflow: names.length > limit,
          };
    }) as StoragePort['readDirectoryBoundedSync'],
    readFileSync: vi.fn((rawPath: StoragePath) => {
      const path = String(rawPath);
      const name = basename(path);
      const attempt = (readAttempts.get(name) ?? 0) + 1;
      readAttempts.set(name, attempt);
      if (refusedReadNames.has(name) || options.refuseReadWhen?.(name, attempt) === true) {
        throw Object.assign(new Error('read refused'), { code: options.readErrorCode ?? 'EIO' });
      }
      const file = files.get(path);
      if (file === undefined) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      return file.value;
    }) as StoragePort['readFileSync'],
    statSync: vi.fn((rawPath: StoragePath, statOptions?: { bigint: true }) => {
      const path = String(rawPath);
      if (basename(path) === options.refuseStatFor) {
        throw Object.assign(new Error('stat refused'), { code: options.statErrorCode ?? 'EIO' });
      }
      if (directories.has(path)) {
        return statOptions?.bigint === true
          ? {
              dev: 1n,
              ino: 0n,
              nlink: 1n,
              mode: 0n,
              size: 0n,
              mtimeNs: 0n,
              isDirectory: () => true,
              isFile: () => false,
            }
          : { size: 0, mtimeMs: 0, isDirectory: () => true, isFile: () => false };
      }
      const file = files.get(path);
      if (file === undefined) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      return statOptions?.bigint === true
        ? {
            dev: 1n,
            ino: file.ino,
            nlink: BigInt([...files.values()].filter((candidate) => candidate === file).length),
            mode: 0n,
            size: BigInt(Buffer.byteLength(file.value)),
            mtimeNs: BigInt(file.mtimeMs) * 1_000_000n,
            isDirectory: () => false,
            isFile: () => true,
          }
        : {
            size: Buffer.byteLength(file.value),
            mtimeMs: file.mtimeMs,
            isDirectory: () => false,
            isFile: () => true,
          };
    }) as unknown as StoragePort['statSync'],
    lstatSync: vi.fn((rawPath: StoragePath) => {
      const path = String(rawPath);
      if (basename(path) === options.refuseLstatFor) {
        throw Object.assign(new Error('lstat refused'), { code: options.lstatErrorCode ?? 'EIO' });
      }
      const isDirectory = directories.has(path);
      if (!isDirectory && !files.has(path)) throw Object.assign(new Error('missing entry'), { code: 'ENOENT' });
      return {
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
        isSymbolicLink: () => false,
      };
    }) as unknown as StoragePort['lstatSync'],
    unlinkSync: vi.fn((rawPath: StoragePath) => {
      const path = String(rawPath);
      const name = basename(path);
      const attempt = (pruneAttempts.get(name) ?? 0) + 1;
      pruneAttempts.set(name, attempt);
      if (options.disappearDuringPruneWhen?.(name, attempt) === true) {
        files.delete(path);
        throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      }
      if (options.refusePrune === true || options.refusePruneWhen?.(name, attempt) === true) {
        const error = new Error('prune refused');
        throw options.pruneErrorCode === undefined ? error : Object.assign(error, { code: options.pruneErrorCode });
      }
      if (!files.delete(path)) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    }),
    mkdirSync: vi.fn((path: string, mkdirOptions?: { recursive?: boolean }) => {
      if ((options.maxComponentBytes ?? Number.POSITIVE_INFINITY) < Buffer.byteLength(basename(path))) {
        throw Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' });
      }
      if (directories.has(path)) {
        if (mkdirOptions?.recursive === true) return;
        throw Object.assign(new Error('directory exists'), { code: 'EEXIST' });
      }
      if (mkdirOptions?.recursive === true) {
        const missing: string[] = [];
        for (let candidate = path; candidate !== dirname(candidate); candidate = dirname(candidate)) {
          if (directories.has(candidate)) break;
          missing.push(candidate);
        }
        for (const candidate of missing.reverse()) directories.add(candidate);
        return;
      }
      if (!directories.has(dirname(path))) throw Object.assign(new Error('missing parent'), { code: 'ENOENT' });
      directories.add(path);
    }),
    renameSync: vi.fn((rawOldPath: StoragePath, rawNewPath: StoragePath) => {
      const oldPath = String(rawOldPath);
      const newPath = String(rawNewPath);
      if ((options.maxComponentBytes ?? Number.POSITIVE_INFINITY) < Buffer.byteLength(basename(newPath))) {
        throw Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' });
      }
      if (options.refuseAtomicRename === true && newPath.includes('.json.stage.')) {
        throw Object.assign(new Error('atomic rename refused'), { code: 'EACCES' });
      }
      if (
        options.publishStageBeforeFinalRename === true &&
        !stagePublishedBeforeFinalRename &&
        oldPath.includes('.json.stage.') &&
        !oldPath.endsWith('.tmp') &&
        newPath.endsWith('.json')
      ) {
        stagePublishedBeforeFinalRename = true;
        pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR, observeStageWriter: () => 'alive' });
      }
      if (
        options.replaceStageBeforeFinalRenameWith !== undefined &&
        oldPath.includes('.json.stage.') &&
        !oldPath.endsWith('.tmp') &&
        newPath.endsWith('.json')
      ) {
        files.delete(oldPath);
        files.set(newPath, { value: options.replaceStageBeforeFinalRenameWith, mtimeMs: ++clock, ino: nextIno++ });
        throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      }
      if (
        options.publishDuringPruneRename === true &&
        !stagePublishedDuringPruneRename &&
        oldPath.includes('.json.stage.') &&
        !oldPath.endsWith('.tmp') &&
        newPath.endsWith('.json')
      ) {
        stagePublishedDuringPruneRename = true;
        const file = files.get(oldPath);
        if (file === undefined) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
        files.delete(oldPath);
        files.set(newPath, file);
        throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      }
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
      files.set(tempPath, { value, mtimeMs: ++clock, ino: nextIno++ });
      if (options.pruneBeforeAtomicRename === true) {
        pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR, observeStageWriter: () => 'alive' });
      }
      storage.renameSync(tempPath, path);
      return true;
    }),
    writeAtomicDurableSync: vi.fn((path: string, data: string | NodeJS.ArrayBufferView) => {
      if (options.publish === false) return false;
      const value =
        typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
      files.set(path, { value, mtimeMs: ++clock, ino: nextIno++ });
      return true;
    }),
    fileNames: () =>
      [...files.keys()]
        .filter((file) => dirname(file) === REMAINDER_DIRECTORY)
        .map((file) => relative(REMAINDER_DIRECTORY, file))
        .sort(),
    readFile: (name: string) => files.get(join(REMAINDER_DIRECTORY, name))?.value ?? null,
    readPublished: (instanceId: string) => files.get(join(REMAINDER_DIRECTORY, `${instanceId}.json`))?.value ?? null,
  } satisfies RemainderStorage;

  return storage;
}

function writeRuntime(storage: RemainderStorage) {
  return {
    storage,
    time: { now: () => 1_788_739_200_000 },
    runDir: RUN_DIR,
    writer: { pid: 4_242, incarnation: null },
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

function cleanupRefusal(subject: string, operation: 'delete' | 'promote' | 'scan-directory', code?: string) {
  return {
    subject: shutdownRemainderFilesystemSubject(subject),
    cause:
      code === undefined
        ? { kind: 'unclassified-error' as const, operation }
        : { kind: 'system-error' as const, operation, code },
  };
}

function pathWithLength(root: string, length: number): string {
  let path = root;
  while (path.length < length) {
    const componentLength = Math.min(200, length - path.length - 1);
    if (componentLength <= 0) throw new Error(`Cannot extend ${root} to ${length} bytes`);
    path = join(path, 'r'.repeat(componentLength));
  }
  return path;
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
    ).toEqual({ kind: 'published' });

    expect(shutdownRemainderRecordDirectory(RUN_DIR)).toBe(REMAINDER_DIRECTORY);
    expect(storage.mkdirSync).toHaveBeenCalledWith(REMAINDER_DIRECTORY, { recursive: true });
    expect(storage.writeAtomicSync).toHaveBeenCalledWith(
      '/run/shutdown-remainder.v1/current-instance.json.stage.4242.unobserved',
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

  it('keeps raw-name identity distinct when terminal labels require escaping or truncation', () => {
    const escaped = shutdownRemainderFilesystemSubject('same\n.json');
    const replacement = shutdownRemainderFilesystemSubject('same\uFFFD.json');
    const longA = shutdownRemainderFilesystemSubject(`${'x'.repeat(4096)}a`);
    const longB = shutdownRemainderFilesystemSubject(`${'x'.repeat(4096)}b`);

    expect(escaped).toEqual({ identity: sha256Hex('same\n.json'), label: 'same\\u{A}.json' });
    expect(replacement).toEqual({ identity: sha256Hex('same\uFFFD.json'), label: 'same\uFFFD.json' });
    expect(escaped.identity).not.toBe(replacement.identity);
    expect(escaped.label).not.toBe(replacement.label);
    expect(longA.identity).not.toBe(longB.identity);
    expect(longA.label).not.toBe(longB.label);
    expect(longA.label).toHaveLength(4096);
    expect(longB.label).toHaveLength(4096);
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
    ).toEqual({ kind: 'published' });

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
    ).toEqual({ kind: 'published' });

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

  it('carries an unsafe skipped filename as a stable identity and escaped label', () => {
    const storage = storageWith([{ name: 'forged\nrecord.json', value: '{not-json', mtimeMs: 1 }]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      skippedRecords: [
        {
          subject: shutdownRemainderFilesystemSubject('forged\nrecord.json'),
          reason: 'corrupt',
        },
      ],
    });
  });

  it('keeps identity for a skipped filename outside the closed identifier charset', () => {
    const storage = storageWith([{ name: 'forged command=rm -rf ~ (danger).json', value: '{not-json', mtimeMs: 1 }]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      skippedRecords: [
        {
          subject: shutdownRemainderFilesystemSubject('forged command=rm -rf ~ (danger).json'),
          reason: 'corrupt',
        },
      ],
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
        {
          name: 'corrupt-instance.json',
          subject: shutdownRemainderFilesystemSubject('corrupt-instance.json'),
          reason: 'corrupt',
        },
        {
          name: 'foreign-instance.json',
          subject: shutdownRemainderFilesystemSubject('foreign-instance.json'),
          reason: 'unsupported',
          detail: expect.any(String),
        },
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

  it('omits a record confirmed absent during the directory-to-read race', () => {
    const storage = storageWith([{ name: 'vanished-after-stat.json', value: '{not-json', mtimeMs: 1 }], {
      refuseReadFor: 'vanished-after-stat.json',
      readErrorCode: 'ENOENT',
      refuseLstatFor: 'vanished-after-stat.json',
      lstatErrorCode: 'ENOENT',
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
    const storage = storageWith([
      fileAt('branch-complete-canary', 1, {
        ...recordAt('branch-complete-canary', [entry()]),
        ...envelopeAddition(),
      }),
    ]);

    const scan = scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY);

    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]?.entries).toHaveLength(1);
    expect(scan.skippedEntries).toEqual([]);
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
    ).toEqual({ kind: 'published' });

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
    ).toEqual({ kind: 'published' });

    expect(storage.fileNames()).toHaveLength(33);
    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });
    expect(storage.fileNames()).toHaveLength(32);
    expect(storage.fileNames()).not.toContain('instance-0.json');
    expect(storage.fileNames()).toContain('instance-32.json');
  });

  it('keeps a refused retention record once it re-enters the retention window', () => {
    const storage = storageWith(
      Array.from({ length: 33 }, (_, index) => fileAt(`instance-${index}`, index + 1)),
      {
        refusePruneWhen: (name, attempt) => name === 'instance-0.json' && attempt === 1,
      },
    );
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup).toMatchObject({ kind: 'refused' });
    storage.unlinkSync(join(REMAINDER_DIRECTORY, 'instance-1.json'));

    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();

    expect(storage.fileNames()).toHaveLength(32);
    expect(storage.fileNames()).toContain('instance-0.json');
    expect(storage.fileNames()).not.toContain('instance-1.json');
    expect(storage.unlinkSync).toHaveBeenCalledTimes(2);
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

  it('prunes only the oldest known records once they exceed the cap and quarantines an unreadable record', () => {
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

  it('retains every unreadable record without ranking or deleting unknown evidence', () => {
    const unreadableFiles = Array.from({ length: 33 }, (_, index) => fileAt(`unreadable-${index}`, index + 1));
    const storage = storageWith([fileAt('readable', 100), ...unreadableFiles], {
      refuseReadFor: unreadableFiles.map(({ name }) => name),
      readErrorCode: 'EIO',
    });

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toHaveLength(34);
    expect(storage.fileNames()).toContain('readable.json');
    expect(storage.fileNames()).toContain('unreadable-0.json');
    expect(storage.fileNames()).toContain('unreadable-32.json');
    expect(storage.statSync).toHaveBeenCalledTimes(1);
    expect(storage.unlinkSync).not.toHaveBeenCalled();
  });

  it('holds repeated quarantine dispositions at the canonical subject path', () => {
    const first = JSON.stringify(recordAt('same', [KNOWN_LOSS]));
    const second = JSON.stringify(recordAt('same', []));
    const storage = storageWith([{ name: 'same.json', value: first, mtimeMs: 1 }], {
      refuseReadFor: 'same.json',
    });

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });
    storage.writeAtomicSync(join(REMAINDER_DIRECTORY, 'same.json'), second);
    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toEqual(['same.json']);
    expect(storage.readFile('same.json')).toBe(second);
  });

  it('quarantines a 255-byte malformed stage without lengthening its basename', () => {
    const suffix = '.json.stage.bad';
    const name = `${'a'.repeat(255 - Buffer.byteLength(suffix))}${suffix}`;
    const storage = storageWith([{ name, value: '{partial', mtimeMs: 1 }], { maxComponentBytes: 255 });

    const first = pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });
    const second = pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(first.cleanup).toEqual({ kind: 'quarantined', subjectNames: [name] });
    expect(second.cleanup).toEqual({ kind: 'quarantined', subjectNames: [name] });
    expect(storage.fileNames()).toEqual([name]);
  });

  it('holds a maximum-path subject in place without constructing a longer destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-remainder-path-'));
    try {
      const runDir = pathWithLength(root, 3_812);
      const directory = shutdownRemainderRecordDirectory(runDir);
      const suffix = '.json.stage.bad';
      const name = `${'a'.repeat(255 - Buffer.byteLength(suffix))}${suffix}`;
      const subjectPath = join(directory, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(subjectPath, '{partial');

      const disposition = pruneShutdownRemainderRecords({
        runDir,
        storage: createRealRuntime('dev').storage,
      });

      expect(subjectPath).toHaveLength(4_090);
      expect(disposition.cleanup).toEqual({ kind: 'quarantined', subjectNames: [name] });
      expect(readFileSync(subjectPath, 'utf-8')).toBe('{partial');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies one flat-scan I/O budget across stage and record subjects', () => {
    const files = Array.from({ length: 500 }, (_, index) => {
      const ordinal = String(index).padStart(3, '0');
      return [
        fileAt(`entry-${ordinal}`, index + 1),
        { name: `entry-${ordinal}.json.stage.bad`, value: '{}', mtimeMs: index + 1 },
      ];
    }).flat();
    const storage = storageWith(files);

    const scan = scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY);

    expect(scan.entryOverflow).toBe(true);
    expect(vi.mocked(storage.lstatSync).mock.calls.length + vi.mocked(storage.readFileSync).mock.calls.length).toBe(
      SHUTDOWN_REMAINDER_SCAN_LIMIT,
    );
  });

  it('keeps raw-distinct undecodable filenames addressable across the bounded scan and cleanup', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-remainder-raw-names-'));
    const directory = shutdownRemainderRecordDirectory(runDir);
    const rawNames = [
      ...Array.from({ length: 128 }, (_, index) =>
        Buffer.concat([Buffer.from([0x80, 0x80 + index]), Buffer.from('.json')]),
      ),
      Buffer.concat([Buffer.from([0x80, 0x80, 0x80]), Buffer.from('.json')]),
      Buffer.concat([Buffer.from([0x80, 0x80, 0x81]), Buffer.from('.json')]),
    ];
    mkdirSync(directory, { recursive: true });
    for (const rawName of rawNames) {
      writeFileSync(Buffer.concat([Buffer.from(`${directory}/`), rawName]), '{not-json');
    }
    try {
      const realStorage = createRealRuntime('dev').storage;
      let readAttempts = 0;
      const refusingStorage: StoragePort = {
        ...realStorage,
        readFileSync: (path, encoding) => {
          readAttempts += 1;
          return realStorage.readFileSync(path, encoding);
        },
        unlinkSync: () => {
          throw Object.assign(new Error('delete refused'), { code: 'EACCES' });
        },
      };

      const scan = scanShutdownRemainderRecords(refusingStorage, directory);
      expect(scan.skippedRecords).toHaveLength(SHUTDOWN_REMAINDER_SCAN_LIMIT);
      expect(scan.entryOverflow).toBe(true);
      expect(new Set(scan.skippedRecords.map(({ subject }) => subject.identity)).size).toBe(
        SHUTDOWN_REMAINDER_SCAN_LIMIT,
      );
      expect(readAttempts).toBe(SHUTDOWN_REMAINDER_SCAN_LIMIT);

      const disposition = pruneShutdownRemainderRecords({ storage: refusingStorage, runDir });
      if (disposition.cleanup.kind !== 'refused') throw new Error('expected cleanup refusals');
      expect(disposition.cleanup.refusals).toHaveLength(SHUTDOWN_REMAINDER_SCAN_LIMIT);
      expect(disposition.cleanup.unreportedRefusalCount).toBe(2);
      expect(new Set(disposition.cleanup.refusals.map(({ subject }) => subject.identity)).size).toBe(
        SHUTDOWN_REMAINDER_SCAN_LIMIT,
      );
      expect(new Set(rawNames.map((name) => name.toString('utf8'))).size).toBe(2);

      expect(pruneShutdownRemainderRecords({ storage: realStorage, runDir }).cleanup).toEqual({ kind: 'complete' });
      expect(readdirSync(directory, { encoding: 'buffer' })).toEqual([]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('does not probe past empty quarantine slots or leave the subject behind them', () => {
    const storage = storageWith([fileAt('locked', 1)], { refuseReadFor: 'locked.json' });
    for (let slot = 1; slot <= 1_000; slot += 1) {
      storage.mkdirSync(join(REMAINDER_DIRECTORY, 'quarantine', 'locked.json', String(slot)), { recursive: true });
    }
    vi.mocked(storage.mkdirSync).mockClear();

    const disposition = pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(disposition.cleanup).toEqual({ kind: 'quarantined', subjectNames: ['locked.json'] });
    expect(storage.mkdirSync).not.toHaveBeenCalled();
    expect(storage.fileNames()).toContain('locked.json');
  });

  it('reclaims a decisively corrupt record regardless of age, even under the retention cap', () => {
    const storage = storageWith([fileAt('readable', 1), { name: 'corrupt.json', value: '{not-json', mtimeMs: 2 }]);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toEqual(['readable.json']);
  });

  it('quarantines an unsupported record instead of deleting it outright', () => {
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

    const disposition = pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(disposition.cleanup).toEqual({ kind: 'quarantined', subjectNames: ['future-instance.json'] });
    expect(storage.fileNames().sort()).toEqual(['future-instance.json', 'readable.json']);
    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [recordAt('readable')],
      skippedRecords: [{ name: 'future-instance.json', reason: 'unsupported', detail: expect.any(String) }],
    });
  });

  it('does not unlink a live atomic-write staging file when prune runs before rename', () => {
    const storage = storageWith([], { pruneBeforeAtomicRename: true });

    expect(
      recordShutdownRemainder(
        { ...writeRuntime(storage), writer: { pid: 4_242, incarnation: testIncarnation('live-writer') } },
        { instanceId: 'current-instance', reason: 'sigterm', mode: 'handoff', undischarged: [KNOWN_LOSS] },
      ),
    ).toEqual({ kind: 'published' });

    expect(storage.fileNames()).toEqual(['current-instance.json']);
    expect(JSON.parse(storage.readPublished('current-instance') ?? '')).toEqual(recordAt('current-instance'));
  });

  it('promotes a complete stage by content when its writer is unobservable', () => {
    const stageName = 'orphan.json.stage.4242.unobserved';
    const storage = storageWith([{ name: stageName, value: JSON.stringify(recordAt('orphan')), mtimeMs: 1 }]);

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => 'unknown',
    });

    expect(disposition).toEqual({
      stageOwnership: { kind: 'classified' },
      cleanup: { kind: 'complete' },
    });
    expect(storage.fileNames()).toEqual(['orphan.json']);
    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [recordAt('orphan')],
      skippedRecords: [],
    });
  });

  it('promotes a validated complete stage while its writer is proven alive', () => {
    const stageName = 'live.json.stage.4242.unobserved';
    const storage = storageWith([{ name: stageName, value: JSON.stringify(recordAt('live')), mtimeMs: 1 }]);

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => 'alive',
    });

    expect(disposition).toEqual({
      stageOwnership: { kind: 'classified' },
      cleanup: { kind: 'complete' },
    });
    expect(storage.fileNames()).toEqual(['live.json']);
  });

  it('accepts publication when the pruner wins the final rename race', () => {
    const storage = storageWith([], { publishStageBeforeFinalRename: true });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toEqual({ kind: 'published' });
    expect(storage.fileNames()).toEqual(['current-instance.json']);
    expect(JSON.parse(storage.readPublished('current-instance') ?? '')).toEqual(recordAt('current-instance'));
  });

  it('reports publication verification as unavailable when the winning canonical file cannot be read', () => {
    const storage = storageWith([], {
      publishStageBeforeFinalRename: true,
      refuseReadFor: 'current-instance.json',
      readErrorCode: 'EACCES',
    });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({ kind: 'verification-unavailable' });
    expect(storage.fileNames()).toEqual(['current-instance.json']);
  });

  it('does not accept unrelated canonical bytes when its stage disappears before final rename', () => {
    const storage = storageWith([], { replaceStageBeforeFinalRenameWith: 'third-party' });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({ kind: 'refused', detail: expect.stringContaining('missing file') });
    expect(storage.readPublished('current-instance')).toBe('third-party');
  });

  it('accepts a stage publication that wins the pruner rename race', () => {
    const stageName = 'published.json.stage.4242.unobserved';
    const storage = storageWith([{ name: stageName, value: JSON.stringify(recordAt('published')), mtimeMs: 1 }], {
      publishDuringPruneRename: true,
    });

    expect(pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR, observeStageWriter: () => 'alive' })).toEqual({
      stageOwnership: { kind: 'classified' },
      cleanup: { kind: 'complete' },
    });
    expect(storage.fileNames()).toEqual(['published.json']);
  });

  it('never promotes a complete atomic-write temporary file after publication and cleanup both fail', () => {
    const storage = storageWith([], { refuseAtomicRename: true, refusePrune: true });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'declined',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({ kind: 'refused', detail: expect.stringContaining('atomic rename refused') });
    expect(storage.fileNames()).toEqual(['declined.json.stage.4242.unobserved.tmp']);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR, observeStageWriter: () => 'absent' });

    expect(storage.fileNames()).not.toContain('declined.json');
    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY, () => 'absent').records).toEqual([]);
  });

  it.each([['held.json.stage.4242.bad'], ['held.json.stage.4242.bad.json']])(
    'reports malformed stage-shaped entry %s without treating it as a published record',
    (name) => {
      const storage = storageWith([{ name, value: JSON.stringify(recordAt('held')), mtimeMs: 1 }]);

      expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
        records: [],
        skippedRecords: [{ name, reason: 'malformed-staging' }],
      });
    },
  );

  it('requires a final record filename to match its decoded instance identity exactly', () => {
    const storage = storageWith([
      { name: 'wrong.json', value: JSON.stringify(recordAt('actual-instance')), mtimeMs: 1 },
    ]);

    expect(scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY)).toMatchObject({
      records: [],
      skippedRecords: [{ name: 'wrong.json', reason: 'record-identity-mismatch' }],
    });
  });

  it('names a refused cleanup of an identity-mismatched record', () => {
    const storage = storageWith(
      [{ name: 'wrong.json', value: JSON.stringify(recordAt('actual-instance')), mtimeMs: 1 }],
      { refusePrune: true },
    );

    expect(pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR }).cleanup).toEqual({
      kind: 'refused',
      refusals: [cleanupRefusal('wrong.json', 'delete')],
    });
  });

  it('quarantines a partial stage when its writer is unobservable', () => {
    const stageName = 'held.json.stage.4242.unobserved.tmp';
    const storage = storageWith([{ name: stageName, value: JSON.stringify(recordAt('held')), mtimeMs: 1 }]);

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => 'unknown',
    });

    expect(disposition).toEqual({
      stageOwnership: { kind: 'classified' },
      cleanup: { kind: 'quarantined', subjectNames: [stageName] },
    });
    expect(storage.fileNames()).toEqual([stageName]);
  });

  it('returns quarantined stage evidence together with an unrelated cleanup refusal', () => {
    const stageName = 'held.json.stage.4242.unobserved.tmp';
    const storage = storageWith(
      [
        { name: stageName, value: JSON.stringify(recordAt('held')), mtimeMs: 1 },
        { name: 'corrupt.json', value: '{not-json', mtimeMs: 2 },
      ],
      { refusePrune: true },
    );

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => 'unknown',
    });

    expect(disposition).toEqual({
      stageOwnership: { kind: 'classified' },
      cleanup: {
        kind: 'refused',
        refusals: [cleanupRefusal('corrupt.json', 'delete')],
        quarantinedSubjectNames: [stageName],
      },
    });
  });

  it('bounds reported cleanup refusals without relabelling overflow as unchecked', () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      name: 'corrupt-' + String(index).padStart(3, '0') + '.json',
      value: '{not-json',
      mtimeMs: index + 1,
    }));
    const storage = storageWith(files, { refusePrune: true });
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: { setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn() },
    });

    const disposition = pruner.start();
    expect(disposition?.cleanup).toMatchObject({
      kind: 'refused',
      unreportedRefusalCount: 300 - SHUTDOWN_REMAINDER_SCAN_LIMIT,
    });
    vi.mocked(storage.unlinkSync).mockClear();
    vi.mocked(storage.lstatSync).mockClear();

    const snapshot = pruner.readCleanupRefusalSnapshot();
    expect(snapshot).toMatchObject({
      resolvedRefusalCount: 0,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      overflowedRefusalCount: 300 - SHUTDOWN_REMAINDER_SCAN_LIMIT,
    });
    expect(snapshot.refusals).toHaveLength(SHUTDOWN_REMAINDER_SCAN_LIMIT);
    expect(storage.unlinkSync).not.toHaveBeenCalled();
    expect(storage.lstatSync).not.toHaveBeenCalled();
  });

  it.each([
    [128, 1],
    [129, 2],
    [1_000, 8],
  ])('reports a stable population of %i refusals within %i snapshots', (population, snapshotCount) => {
    const files = Array.from({ length: population }, (_, index) => ({
      name: `refusal-${String(index).padStart(4, '0')}.json`,
      value: '{not-json',
      mtimeMs: index + 1,
    }));
    const storage = storageWith(files, { refusePrune: true, pruneErrorCode: 'EACCES' });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    pruner.start();
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    const observedIdentities = new Set<string>();
    for (let snapshotNumber = 0; snapshotNumber < snapshotCount; snapshotNumber += 1) {
      if (snapshotNumber > 0) periodic();
      for (const refusal of pruner.readCleanupRefusalSnapshot().refusals) {
        observedIdentities.add(refusal.subject.identity);
      }
    }

    expect(observedIdentities).toEqual(
      new Set(files.map(({ name }) => shutdownRemainderFilesystemSubject(name).identity)),
    );
  });

  it('does not let replacement cohorts overtake an older unreported refusal', () => {
    const targetName = 'z-target.json';
    const cohortFiles = (prefix: string) =>
      Array.from({ length: SHUTDOWN_REMAINDER_SCAN_LIMIT }, (_, index) => ({
        name: `${prefix}-${String(index).padStart(3, '0')}.json`,
        value: '{not-json',
        mtimeMs: index + 1,
      }));
    let refusePrune = true;
    const storage = storageWith(
      [
        ...cohortFiles('a'),
        {
          name: targetName,
          value: '{not-json',
          mtimeMs: SHUTDOWN_REMAINDER_SCAN_LIMIT + 1,
        },
      ],
      { refusePruneWhen: () => refusePrune, pruneErrorCode: 'EACCES' },
    );
    let scheduled: (() => void) | null = null;
    let now = Date.parse('2026-09-20T00:00:00.000Z');
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        now: () => now,
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup).toMatchObject({ kind: 'refused', refusals: expect.any(Array) });
    expect(pruner.readCleanupRefusalSnapshot().refusals).toHaveLength(SHUTDOWN_REMAINDER_SCAN_LIMIT);
    expect(pruner.readCleanupRefusalSnapshot().refusals.map(({ subject }) => subject.identity)).not.toContain(
      shutdownRemainderFilesystemSubject(targetName).identity,
    );
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    const observedIdentities = new Set<string>();
    let previousPrefix = 'a';
    for (let scheduledSnapshot = 0; scheduledSnapshot < 12; scheduledSnapshot += 1) {
      const nextPrefix = String.fromCharCode('b'.charCodeAt(0) + scheduledSnapshot);
      refusePrune = false;
      for (const { name } of cohortFiles(previousPrefix)) storage.unlinkSync(join(REMAINDER_DIRECTORY, name));
      for (const { name, value } of cohortFiles(nextPrefix)) {
        storage.writeAtomicSync(join(REMAINDER_DIRECTORY, name), value);
      }
      refusePrune = true;
      previousPrefix = nextPrefix;
      now += 60_000;
      periodic();
      const snapshot = pruner.readCleanupRefusalSnapshot();
      expect(snapshot.refusals).toHaveLength(SHUTDOWN_REMAINDER_SCAN_LIMIT);
      expect(snapshot).toMatchObject({
        resolvedRefusalCount: 0,
        absentRefusalCount: SHUTDOWN_REMAINDER_SCAN_LIMIT,
        unobservableRefusalCount: 0,
        uncheckedRefusalCount: 0,
        overflowedRefusalCount: 1,
        retry: { state: 'scheduled', owner: 'coordinator' },
      });
      for (const refusal of snapshot.refusals) observedIdentities.add(refusal.subject.identity);
    }

    expect(observedIdentities).toContain(shutdownRemainderFilesystemSubject(targetName).identity);
    expect(storage.fileNames()).toContain(targetName);
    expect(
      vi.mocked(storage.unlinkSync).mock.calls.filter(([path]) => basename(String(path)) === targetName),
    ).toHaveLength(13);
  });

  it('preserves unreported debt when a retention-boundary refusal temporarily resolves', () => {
    const targetName = 'target.json';
    const corruptFiles = Array.from({ length: SHUTDOWN_REMAINDER_SCAN_LIMIT }, (_, index) => ({
      name: `corrupt-${String(index).padStart(3, '0')}.json`,
      value: '{not-json',
      mtimeMs: index + 1,
    }));
    const peerNames = Array.from({ length: 32 }, (_, index) => `peer-${String(index).padStart(2, '0')}`);
    const storage = storageWith(
      [
        ...corruptFiles,
        { name: targetName, value: JSON.stringify(recordAt('target')), mtimeMs: 0 },
        ...peerNames.map((name, index) => fileAt(name, 1_000 + index)),
      ],
      { refusePrune: true, pruneErrorCode: 'EACCES' },
    );
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    pruner.start();
    const targetIdentity = shutdownRemainderFilesystemSubject(targetName).identity;
    expect(pruner.readCleanupRefusalSnapshot().refusals.map(({ subject }) => subject.identity)).not.toContain(
      targetIdentity,
    );
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    const observedIdentities = new Set<string>();
    for (let pruneNumber = 0; pruneNumber < 12; pruneNumber += 1) {
      if (pruneNumber % 2 === 0) {
        storage.writeAtomicSync(join(REMAINDER_DIRECTORY, targetName), JSON.stringify(recordAt('target')));
      } else {
        for (const name of peerNames) {
          storage.writeAtomicSync(join(REMAINDER_DIRECTORY, `${name}.json`), JSON.stringify(recordAt(name)));
        }
      }
      periodic();
      for (const refusal of pruner.readCleanupRefusalSnapshot().refusals) {
        observedIdentities.add(refusal.subject.identity);
      }
    }

    expect(observedIdentities).toContain(targetIdentity);
    expect(storage.fileNames()).toContain(targetName);
  });

  it('retries a refused operation only on periodic reclassification and reports it resolved', () => {
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refusePruneWhen: (_name, attempt) => attempt === 1,
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup.kind).toBe('refused');
    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [cleanupRefusal('corrupt.json', 'delete')],
      resolvedRefusalCount: 0,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();
    expect(storage.fileNames()).toEqual([]);
    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [],
      resolvedRefusalCount: 1,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
  });

  it('classifies a refused cleanup subject as absent when its retry loses the unlink race', () => {
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refusePruneWhen: (name, attempt) => name === 'corrupt.json' && attempt === 1,
      disappearDuringPruneWhen: (name, attempt) => name === 'corrupt.json' && attempt === 2,
      pruneErrorCode: 'EACCES',
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup).toEqual({
      kind: 'refused',
      refusals: [cleanupRefusal('corrupt.json', 'delete', 'EACCES')],
    });
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();

    expect(storage.fileNames()).toEqual([]);
    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [],
      resolvedRefusalCount: 0,
      absentRefusalCount: 1,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
  });

  it('uses a successful content reclassification despite an inconclusive lexical metadata read', () => {
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refusePruneWhen: (_name, attempt) => attempt === 1,
      refuseLstatFor: 'corrupt.json',
      lstatErrorCode: 'EIO',
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup.kind).toBe('refused');
    storage.writeAtomicSync(join(REMAINDER_DIRECTORY, 'corrupt.json'), JSON.stringify(recordAt('corrupt')));
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();
    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [],
      resolvedRefusalCount: 1,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
  });

  it('quarantines every writer-owned stage whose writer is unobservable without a count bound', () => {
    const stages = Array.from({ length: 33 }, (_, index) => ({
      name: `held-${index}.json.stage.${5_000 + index}.unobserved.tmp`,
      value: JSON.stringify(recordAt(`held-${index}`)),
      mtimeMs: index + 1,
    }));
    const storage = storageWith(stages);

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => 'unknown',
    });

    expect(disposition).toMatchObject({
      stageOwnership: { kind: 'classified' },
      cleanup: { kind: 'quarantined' },
    });
    expect(storage.unlinkSync).not.toHaveBeenCalled();
    expect(storage.fileNames()).toEqual(stages.map(({ name }) => name).sort());
  });

  it('quarantines unobservable and proven-orphan stages whose content cannot be published', () => {
    const orphanedStages = Array.from({ length: 32 }, (_, index) => ({
      name: `orphan-${index}.json.stage.${6_000 + index}.unobserved`,
      value: '{}',
      mtimeMs: index + 1,
    }));
    const heldStage = {
      name: 'held.json.stage.7000.unobserved.tmp',
      value: JSON.stringify(recordAt('held')),
      mtimeMs: 0,
    };
    const storage = storageWith([heldStage, ...orphanedStages]);

    const disposition = pruneShutdownRemainderRecords({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: ({ pid }) => (pid === 7_000 ? 'unknown' : 'absent'),
    });

    expect(disposition.stageOwnership).toEqual({ kind: 'classified' });
    expect(disposition.cleanup).toMatchObject({ kind: 'quarantined' });
    expect(storage.unlinkSync).not.toHaveBeenCalled();
    expect(storage.fileNames()).toHaveLength(33);
    expect(storage.fileNames()).toContain(heldStage.name);
  });

  it('publishes after a writer changes from alive to absent while the coordinator keeps running', () => {
    const stageName = 'held.json.stage.4242.unobserved';
    const storage = storageWith([], {
      refuseReadWhen: (name, attempt) => name === stageName && attempt === 1,
    });
    storage.mkdirSync(REMAINDER_DIRECTORY, { recursive: true });
    const observations: Array<'alive' | 'absent'> = ['alive', 'absent'];
    let scheduled: (() => void) | null = null;
    const timer = { unref: vi.fn() };
    const clearInterval = vi.fn(() => {
      scheduled = null;
    });
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      observeStageWriter: () => observations.shift() ?? 'absent',
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return timer;
        },
        clearInterval,
      },
    });

    expect(pruner.start()).toEqual({
      stageOwnership: { kind: 'classified' },
      cleanup: { kind: 'complete' },
    });
    storage.writeAtomicSync(join(REMAINDER_DIRECTORY, stageName), JSON.stringify(recordAt('held')));

    const observeAlive = scheduled as (() => void) | null;
    if (observeAlive === null) throw new Error('periodic re-observation was not scheduled');
    observeAlive();

    expect(storage.fileNames()).toEqual([stageName]);
    expect(timer.unref).toHaveBeenCalledOnce();

    const observeAbsent = scheduled as (() => void) | null;
    if (observeAbsent === null) throw new Error('periodic re-observation was not scheduled');
    observeAbsent();

    expect(storage.fileNames()).toEqual(['held.json']);
    expect(JSON.parse(storage.readPublished('held') ?? '')).toEqual(recordAt('held'));
    pruner.stop();
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it('does not report a permanently unreadable record complete while polling it forever', () => {
    const storage = storageWith([fileAt('locked', 1)], {
      refuseReadFor: 'locked.json',
      readErrorCode: 'EACCES',
      refuseReaddirWhen: (_path, attempt) => attempt === 2,
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    const disposition = pruner.start();
    for (let pass = 0; pass < 10; pass += 1) {
      const scan = scheduled as (() => void) | null;
      if (scan === null) throw new Error('periodic re-observation was not scheduled');
      scan();
    }

    expect(disposition?.cleanup.kind).not.toBe('complete');
    expect(
      vi.mocked(storage.readFileSync).mock.calls.filter(([path]) => String(path).startsWith(REMAINDER_DIRECTORY)),
    ).toHaveLength(10);
    expect(storage.fileNames()).toEqual(['locked.json']);
  });

  it('clears a cleanup refusal when the subject is replaced by a record that does not qualify for deletion', () => {
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refusePruneWhen: (name, attempt) => name === 'corrupt.json' && attempt === 1,
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup.kind).toBe('refused');
    storage.writeAtomicSync(join(REMAINDER_DIRECTORY, 'corrupt.json'), JSON.stringify(recordAt('corrupt')));

    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [cleanupRefusal('corrupt.json', 'delete')],
      resolvedRefusalCount: 0,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
    expect(storage.fileNames()).toEqual(['corrupt.json']);

    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();

    expect(storage.fileNames()).toEqual(['corrupt.json']);
    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [],
      resolvedRefusalCount: 1,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
  });

  it('retains a cleanup refusal as unchecked when directory scanning stops before its retry', () => {
    let refuseScan = false;
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refusePrune: true,
      refuseReaddirWhen: () => refuseScan,
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    pruner.start();
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    refuseScan = true;
    periodic();
    refuseScan = false;

    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [
        cleanupRefusal('corrupt.json', 'delete'),
        cleanupRefusal(REMAINDER_DIRECTORY, 'scan-directory', 'EIO'),
      ],
      resolvedRefusalCount: 0,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 1,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
    periodic();
    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [cleanupRefusal('corrupt.json', 'delete')],
      resolvedRefusalCount: 1,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
  });

  it('clears a named cleanup refusal after the subject decisively disappears', () => {
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refusePruneWhen: (name, attempt) => name === 'corrupt.json' && attempt === 1,
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup).toEqual({
      kind: 'refused',
      refusals: [cleanupRefusal('corrupt.json', 'delete')],
    });
    storage.unlinkSync(join(REMAINDER_DIRECTORY, 'corrupt.json'));

    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();

    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [],
      resolvedRefusalCount: 0,
      absentRefusalCount: 1,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
  });

  it('does not retry cleanup refusals when a health snapshot reads them', () => {
    const name = 'corrupt\n.json';
    const storage = storageWith([{ name, value: '{not-json', mtimeMs: 1 }], {
      refusePruneWhen: (candidate, attempt) => candidate === name && attempt === 1,
    });
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: { setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn() },
    });

    expect(pruner.start()?.cleanup.kind).toBe('refused');
    vi.mocked(storage.unlinkSync).mockClear();
    vi.mocked(storage.lstatSync).mockClear();
    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [cleanupRefusal(name, 'delete')],
      resolvedRefusalCount: 0,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
    expect(storage.fileNames()).toEqual([name]);
    expect(storage.unlinkSync).not.toHaveBeenCalled();
    expect(storage.lstatSync).not.toHaveBeenCalled();

    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [cleanupRefusal(name, 'delete')],
      resolvedRefusalCount: 0,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      ...SCHEDULED_SNAPSHOT_METADATA,
    });
  });

  it('marks a stopped snapshot with its observation time and next retry owner', () => {
    const storage = storageWith([{ name: 'corrupt.json', value: '{not-json', mtimeMs: 1 }], {
      refusePruneWhen: (name, attempt) => name === 'corrupt.json' && attempt === 1,
      pruneErrorCode: 'EACCES',
    });
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        now: () => Date.parse('2026-09-20T00:00:00.000Z'),
        setInterval: () => ({ unref: vi.fn() }),
        clearInterval: vi.fn(),
      },
    });

    pruner.start();
    pruner.stop();
    storage.unlinkSync(join(REMAINDER_DIRECTORY, 'corrupt.json'));

    expect(pruner.readCleanupRefusalSnapshot()).toEqual({
      refusals: [cleanupRefusal('corrupt.json', 'delete', 'EACCES')],
      resolvedRefusalCount: 0,
      absentRefusalCount: 0,
      unobservableRefusalCount: 0,
      uncheckedRefusalCount: 0,
      overflowedRefusalCount: 0,
      observedAt: '2026-09-20T00:00:00.000Z',
      retry: { state: 'stopped-until-restart', owner: 'next-coordinator-start' },
    });
    expect(storage.fileNames()).toEqual([]);
  });

  it('retains and reports a dangling symlink subject across a pruner restart', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-remainder-symlink-'));
    const directory = shutdownRemainderRecordDirectory(runDir);
    const targetPath = join(runDir, 'target.json');
    const subjectPath = join(directory, 'held.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(targetPath, '{not-json');
    symlinkSync(targetPath, subjectPath);
    try {
      const storage = {
        ...createRealRuntime('dev').storage,
        unlinkSync: (path: StoragePath) => {
          if (String(path) === subjectPath) {
            throw Object.assign(new Error('delete refused'), { code: 'EACCES' });
          }
          unlinkSync(path);
        },
      };
      const pruner = createShutdownRemainderPruner({
        storage,
        runDir,
        time: { setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn() },
      });

      expect(pruner.start()?.cleanup).toEqual({
        kind: 'refused',
        refusals: [cleanupRefusal('held.json', 'delete', 'EACCES')],
      });
      unlinkSync(targetPath);

      expect(lstatSync(subjectPath).isSymbolicLink()).toBe(true);
      expect(pruner.readCleanupRefusalSnapshot().refusals).toEqual([cleanupRefusal('held.json', 'delete', 'EACCES')]);
      pruner.stop();

      const restarted = createShutdownRemainderPruner({
        storage,
        runDir,
        time: { setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn() },
      });
      expect(restarted.start()?.cleanup).toEqual({ kind: 'quarantined', subjectNames: ['held.json'] });
      expect(scanShutdownRemainderRecords(storage, directory)).toMatchObject({
        skippedRecords: [{ name: 'held.json', reason: 'unreadable' }],
      });
      restarted.stop();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('retries a transiently unreadable record on the same pruner schedule', () => {
    const storage = storageWith([fileAt('locked', 1)], {
      refuseReadWhen: (name, attempt) => name === 'locked.json' && attempt === 1,
      readErrorCode: 'EACCES',
    });
    let scheduled: (() => void) | null = null;
    const time = {
      setInterval: vi.fn((callback: () => void) => {
        scheduled = callback;
        return { unref: vi.fn() };
      }),
      clearInterval: vi.fn(),
    };

    const pruner = createShutdownRemainderPruner({ storage, runDir: RUN_DIR, time });
    expect(pruner.start()?.cleanup).toEqual({ kind: 'quarantined', subjectNames: ['locked.json'] });
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();

    expect(pruner.readCleanupRefusalSnapshot().refusals).toEqual([]);
    expect(storage.fileNames()).toEqual(['locked.json']);
    expect(
      vi.mocked(storage.readFileSync).mock.calls.filter(([path]) => String(path).startsWith(REMAINDER_DIRECTORY)),
    ).toHaveLength(2);
    pruner.stop();
  });

  it('keeps a named cleanup refusal when stage promotion failed and its writer is absent', () => {
    const stageName = 'held-stage.json.stage.4242.unobserved';
    const storage = storageWith([{ name: stageName, value: JSON.stringify(recordAt('held-stage')), mtimeMs: 1 }], {
      refuseFinalRename: true,
    });

    expect(
      pruneShutdownRemainderRecords({
        storage,
        runDir: RUN_DIR,
        observeStageWriter: () => 'absent',
      }).cleanup,
    ).toEqual({
      kind: 'refused',
      refusals: [cleanupRefusal(stageName, 'promote', 'EIO')],
    });
  });

  it('reobserves a replaced held subject on the same pruner schedule', () => {
    const active = JSON.stringify(recordAt('locked', []));
    const quarantined = JSON.stringify(recordAt('locked'));
    const storage = storageWith([{ name: 'locked.json', value: quarantined, mtimeMs: 1 }], {
      refuseReadWhen: (name, attempt) => name === 'locked.json' && attempt === 1,
    });
    let scheduled: (() => void) | null = null;
    const pruner = createShutdownRemainderPruner({
      storage,
      runDir: RUN_DIR,
      time: {
        setInterval: (callback) => {
          scheduled = callback;
          return { unref: vi.fn() };
        },
        clearInterval: vi.fn(),
      },
    });

    expect(pruner.start()?.cleanup).toEqual({ kind: 'quarantined', subjectNames: ['locked.json'] });
    storage.writeAtomicSync(join(REMAINDER_DIRECTORY, 'locked.json'), active);
    const periodic = scheduled as (() => void) | null;
    if (periodic === null) throw new Error('periodic remainder maintenance was not scheduled');
    periodic();
    expect(storage.readPublished('locked')).toBe(active);
    expect(
      vi.mocked(storage.readFileSync).mock.calls.filter(([path]) => String(path).startsWith(REMAINDER_DIRECTORY)),
    ).toHaveLength(2);
    pruner.stop();
  });

  it('reclaims every partial stage whose writer is proven absent', () => {
    const stages = Array.from({ length: 40 }, (_, index) => ({
      name: `orphan-${index}.json.stage.${5_000 + index}.unobserved.tmp`,
      value: '{partial',
      mtimeMs: index + 1,
    }));
    const storage = storageWith(stages);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR, observeStageWriter: () => 'absent' });
    const scan = scanShutdownRemainderRecords(storage, REMAINDER_DIRECTORY, () => 'absent');

    expect(storage.fileNames()).toEqual([]);
    expect(scan.records).toEqual([]);
    expect(scan.skippedRecords).toEqual([]);
  });

  it('quarantines malformed stage-shaped entries without inspecting their content or applying a count bound', () => {
    const stages = Array.from({ length: 33 }, (_, index) => ({
      name: `malformed-${index}.json.stage.bad`,
      value: JSON.stringify(recordAt(`malformed-${index}`)),
      mtimeMs: index + 1,
    }));
    const storage = storageWith(stages);

    pruneShutdownRemainderRecords({ storage, runDir: RUN_DIR });

    expect(storage.fileNames()).toHaveLength(33);
    expect(storage.fileNames()).toContain('malformed-0.json.stage.bad');
    expect(storage.readFileSync).not.toHaveBeenCalled();
  });

  it('removes both writer-owned stage forms when final publication fails', () => {
    const storage = storageWith([], { refuseFinalRename: true });

    expect(
      recordShutdownRemainder(writeRuntime(storage), {
        instanceId: 'current-instance',
        reason: 'sigterm',
        mode: 'handoff',
        undischarged: [KNOWN_LOSS],
      }),
    ).toMatchObject({ kind: 'refused', detail: expect.stringContaining('rename refused') });
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
    ).toEqual({ kind: 'published' });
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
    ).toEqual({ kind: 'refused', detail: 'record publication returned false' });
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
    ).toEqual({ kind: 'published' });

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
