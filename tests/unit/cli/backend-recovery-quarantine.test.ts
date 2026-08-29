import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRecoveryQuarantineCommandOperations,
  listRecoveryQuarantineLocal,
  registerBackendCommands,
  type RecoveryQuarantineCommandOperations,
  type UnreadableProviderOperationDiscardCommandResult,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import { collectCommandCoverage } from '#src/cli/classify.js';
import {
  formatRecoveryQuarantineClear,
  formatRecoveryQuarantineList,
  formatUnreadableProviderOperationDiscard,
} from '#src/cli/format/backend.js';
import { buildProgram } from '#src/cli/program.js';
import { encodeRecoveryQuarantineKey, RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, classifyStoreFile, openStoreDatabase } from '#src/store/db.js';
import { PROVIDER_OPERATION_RECORD_VERSION } from '#src/store/provider-operation-record.js';
import * as ipcEnsure from '#src/transport/ipc/ensure.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';

const storeReset: StoreResetCommandOperations = {
  list: () => ({ incidents: [] }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
};

const tempDirectories: string[] = [];
let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function programWith(recoveryQuarantine: RecoveryQuarantineCommandOperations): Command {
  const program = new Command();
  program.exitOverride();
  registerBackendCommands(program, { storeReset, recoveryQuarantine });
  return program;
}

describe('backend recovery-quarantine commands', () => {
  it('should list retained rows directly while no daemon exists', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-cli-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openStoreDatabase({
      path: dbPath,
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
    });
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    quarantine.upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-1', revision: { kind: 'fingerprint', value: 'revision-1' } },
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'failed to hydrate persisted workflow',
      detail: 'retained for operator retry',
    });
    quarantine.upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-literal-sentinel', revision: { kind: 'fingerprint', value: 'until-cleared' } },
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'literal sentinel fingerprint',
      detail: 'must remain representable',
    });
    quarantine.upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-unversioned', revision: { kind: 'until-cleared' } },
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'until cleared',
      detail: 'sentinel revision',
    });
    db.close();

    const entries = listRecoveryQuarantineLocal(runtime);
    const clear = vi.fn();
    await programWith({ list: () => entries, clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'list',
    ]);

    expect(clear).not.toHaveBeenCalled();
    expect(entries).toHaveLength(3);
    expect(stdout).toBe(`${formatRecoveryQuarantineList(entries)}\n`);
    expect(stdout).toContain(
      `- boundary="workflow-recovery" key=${encodeRecoveryQuarantineKey(
        'workflow-1',
      )} revision="fingerprint:revision-1" state=active stage=hydrate`,
    );
    expect(stdout).toContain(
      `key=${encodeRecoveryQuarantineKey('workflow-literal-sentinel')} revision="fingerprint:until-cleared"`,
    );
    expect(stdout).toContain(`key=${encodeRecoveryQuarantineKey('workflow-unversioned')} revision="until-cleared"`);
    expect(stderr).toBe('');
  });

  it('should derive a visible coordinate when an unreadable provider operation has no quarantine row', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-unreadable-provider-operation-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = runtime.paths.coral.store.dbFile;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openStoreDatabase({
      path: dbPath,
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
    });
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const key =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` + 'job-1:operation-1:proxy-1:build-1';
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, 'not-json');
    expect(RecoveryQuarantineStore.readOnly(db).list()).toEqual([]);
    db.close();

    const entries = listRecoveryQuarantineLocal(runtime);

    expect(entries).toEqual([
      expect.objectContaining({
        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
        subject: expect.objectContaining({
          key,
          revision: { kind: 'fingerprint', value: expect.stringMatching(/^sha256:/u) },
        }),
        state: 'active',
        stage: 'hydrate',
        detectedAt: null,
        updatedAt: null,
      }),
    ]);
    const rendered = formatRecoveryQuarantineList(entries);
    expect(rendered).toContain(`key=${encodeRecoveryQuarantineKey(key)}`);
    expect(rendered).toContain('detected_at=unavailable updated_at=unavailable');
    expect(rendered).toContain('derived from the durable unreadable provider operation row');
    expect(rendered).not.toContain('discard=');
  });

  it.each([
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      prints: true,
    },
    {
      state: 'retrying' as const,
      retry: { owner: 'retry-owner', token: 'retry-token' },
      continuation: null,
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      prints: false,
    },
    {
      state: 'continuation' as const,
      retry: null,
      continuation: { kind: 'provider-retry', key: 'continuation-key' },
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      prints: false,
    },
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: false,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      prints: false,
    },
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: true,
      revision: { kind: 'until-cleared' as const },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      prints: false,
    },
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'not-a-provider-operation-key',
      prints: false,
    },
  ])(
    'prints discard=$prints for $state persisted=$persisted evidence',
    ({ state, retry, continuation, persisted, revision, key, prints }) => {
      const rendered = formatRecoveryQuarantineList([
        {
          boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
          subject: { key, revision },
          state,
          stage: 'hydrate',
          retry,
          continuation,
          errorMessage: 'unreadable',
          detail: 'operator decision required',
          detectedAt: persisted ? '2026-08-28T00:00:00.000Z' : null,
          updatedAt: persisted ? '2026-08-28T00:00:00.000Z' : null,
        },
      ]);
      expect(rendered.includes('discard=')).toBe(prints);
    },
  );

  it('should send the exact listed unreadable row revision to the destructive discard operation', async () => {
    const key =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      '00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:' +
      '00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004';
    const revision = `sha256:${'a'.repeat(64)}`;
    const entry = {
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject: { key, revision: { kind: 'fingerprint' as const, value: revision } },
      state: 'active' as const,
      stage: 'hydrate' as const,
      retry: null,
      continuation: null,
      errorMessage: 'unreadable',
      detail: 'discardable exact row',
      detectedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    };
    const discardProviderOperation = vi.fn<
      NonNullable<RecoveryQuarantineCommandOperations['discardProviderOperation']>
    >(async (request) => ({ ...request, kind: 'discarded' as const }));

    await programWith({ list: () => [entry], clear: vi.fn(), discardProviderOperation }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'discard-provider-operation',
      '--key',
      encodeRecoveryQuarantineKey(key),
      '--revision',
      `fingerprint:${revision}`,
    ]);

    expect(discardProviderOperation).toHaveBeenCalledWith({ key, revision });
    expect(stdout).toBe(`${formatUnreadableProviderOperationDiscard({ key, revision, kind: 'discarded' })}\n`);
    expect(stdout).toContain('permanently removed');
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it.each<
    Readonly<{
      result: UnreadableProviderOperationDiscardCommandResult;
      exitCode: 0 | 1 | 75;
      stream: 'stdout' | 'stderr';
    }>
  >([
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'discarded' },
      exitCode: 0,
      stream: 'stdout',
    },
    { result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'absent' }, exitCode: 1, stream: 'stderr' },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'readable' },
      exitCode: 1,
      stream: 'stderr',
    },
    {
      result: {
        key: 'raw-key',
        revision: `sha256:${'a'.repeat(64)}`,
        kind: 'revision-mismatch',
        currentRevision: `sha256:${'b'.repeat(64)}`,
      },
      exitCode: 75,
      stream: 'stderr',
    },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'quarantine-not-found' },
      exitCode: 75,
      stream: 'stderr',
    },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'owned', state: 'retrying' },
      exitCode: 75,
      stream: 'stderr',
    },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'owned', state: 'continuation' },
      exitCode: 75,
      stream: 'stderr',
    },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'unsupported-coordinator' },
      exitCode: 75,
      stream: 'stderr',
    },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'coordinator-draining' },
      exitCode: 75,
      stream: 'stderr',
    },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'unsupported-coordinator-result' },
      exitCode: 75,
      stream: 'stderr',
    },
    {
      result: { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}`, kind: 'timeout' },
      exitCode: 75,
      stream: 'stderr',
    },
  ])('maps discard result $result.kind to exit $exitCode on $stream', async ({ result, exitCode, stream }) => {
    const discardProviderOperation = vi.fn(async () => result);
    await programWith({ list: () => [], clear: vi.fn(), discardProviderOperation }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'discard-provider-operation',
      '--key',
      encodeRecoveryQuarantineKey(result.key),
      '--revision',
      `fingerprint:${result.revision}`,
    ]);

    expect(process.exitCode).toBe(exitCode);
    expect(stream === 'stdout' ? stdout : stderr).toContain(encodeRecoveryQuarantineKey(result.key));
    expect(stream === 'stdout' ? stderr : stdout).toBe('');
    if (result.kind.includes('coordinator') || result.kind === 'timeout') {
      expect(stderr).toContain(`revision="fingerprint:${result.revision}"`);
      expect(stderr).toContain('No discard verdict');
    }
  });

  it('should round-trip a fingerprint equal to the until-cleared sentinel', async () => {
    const clear = vi.fn(async (request) => ({
      boundary: request.boundary,
      key: request.key,
      revision: request.revision,
      disposition: 'advanced' as const,
    }));

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      encodeRecoveryQuarantineKey('workflow-literal-sentinel'),
      '--revision',
      'fingerprint:until-cleared',
    ]);

    expect(clear).toHaveBeenCalledWith({
      boundary: 'workflow-recovery',
      key: 'workflow-literal-sentinel',
      revision: 'until-cleared',
    });
    expect(stdout).toContain('revision="fingerprint:until-cleared"');
  });

  it('should treat an unequivocally older store as having no recovery quarantine yet', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-older-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const current = currentCoralStoreFormat();
    const olderFormat: typeof current = {
      ...current,
      productVersion: '0.0.0-0',
      fingerprint: `sha256:${'0'.repeat(64)}`,
    };
    const db = openStoreDatabase({
      path: runtime.paths.coral.store.dbFile,
      storage: runtime.storage,
      storeFormat: olderFormat,
      flavor: runtime.flavor,
    });
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_format_fingerprint'").run(olderFormat.fingerprint);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_product_version'").run(olderFormat.productVersion);
    db.close();

    expect(
      classifyStoreFile(runtime.paths.coral.store.dbFile, runtime.storage, currentCoralStoreFormat()),
    ).toMatchObject({ kind: 'older-incompatible' });
    expect(listRecoveryQuarantineLocal(runtime)).toEqual([]);
  });

  it('should state the daemon-down limitation for an ambiguous store format', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-unsupported-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const current = currentCoralStoreFormat();
    const unsupportedFormat: typeof current = {
      ...current,
      fingerprint: `sha256:${'0'.repeat(64)}`,
    };
    const db = openStoreDatabase({
      path: runtime.paths.coral.store.dbFile,
      storage: runtime.storage,
      storeFormat: unsupportedFormat,
      flavor: runtime.flavor,
    });
    db.close();

    expect(() => listRecoveryQuarantineLocal(runtime)).toThrow(
      /cannot be inspected while the local store is corrupt-or-unsupported.*coral-cli backend status/,
    );
  });

  it.each([
    ['advanced', 'resolved and removed', ''],
    ['quarantined', 'still quarantined', 'recovery-quarantine list'],
    ['continuation', 'partial progress', 'recovery-quarantine list'],
  ] as const)('should render %s as an actionable operator outcome', (disposition, outcome, recovery) => {
    const formatted = formatRecoveryQuarantineClear({
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
      disposition,
    });

    expect(formatted).toContain(outcome);
    if (recovery.length > 0) expect(formatted).toContain(recovery);
  });

  it('should report the exact retry disposition returned by the coordinator', async () => {
    const clear = vi.fn(async () => ({
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
      disposition: 'continuation' as const,
    }));
    const expected = await clear();
    clear.mockClear();

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      encodeRecoveryQuarantineKey('workflow-1'),
      '--revision',
      'revision-1',
    ]);

    expect(clear).toHaveBeenCalledWith({
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
    });
    expect(stdout).toBe(`${formatRecoveryQuarantineClear(expected)}\n`);
    expect(stdout).toContain('partial progress');
    expect(stdout).toContain('recovery-quarantine list');
    expect(stderr).toBe('');
  });

  it.each([
    ['the new encoded token', encodeRecoveryQuarantineKey('job-123'), 'job-123'],
    ['a shipped plain key', 'job-123', 'job-123'],
    ['a shipped JSON-quoted key', '"job-123"', 'job-123'],
    ['a shipped plain key with the encoding prefix', 'rqk1-legacy', 'rqk1-legacy'],
  ])('should resolve %s to the stored recovery key', async (_form, argument, storedKey) => {
    const clear = vi.fn(async (request: { boundary: string; key: string; revision: string | null }) => ({
      ...request,
      disposition: 'advanced' as const,
    }));

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      argument,
      '--revision',
      'revision-1',
    ]);

    expect(clear).toHaveBeenCalledWith({
      boundary: 'workflow-recovery',
      key: storedKey,
      revision: 'revision-1',
    });
  });

  it('should resolve a stored raw key that is also a well-formed encoded token as the raw key', async () => {
    const storedKey = 'rqk1-0061';
    const entry = {
      boundary: 'workflow-recovery',
      subject: { key: storedKey, revision: { kind: 'fingerprint' as const, value: 'revision-1' } },
      state: 'active' as const,
      stage: 'hydrate' as const,
      errorMessage: 'failed to hydrate persisted workflow',
      detail: 'retained for operator retry',
      retry: null,
      continuation: null,
      detectedAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    };
    const clear = vi.fn(async (request: { boundary: string; key: string; revision: string | null }) => ({
      ...request,
      disposition: 'advanced' as const,
    }));

    await programWith({ list: () => [entry], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      storedKey,
      '--revision',
      'revision-1',
    ]);

    expect(clear).toHaveBeenCalledWith({
      boundary: 'workflow-recovery',
      key: storedKey,
      revision: 'revision-1',
    });
  });

  it('should execute the continuation instruction and show the durable continuation', async () => {
    const instruction = 'coral-cli backend recovery-quarantine list';
    const continuation = {
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-1', revision: { kind: 'fingerprint' as const, value: 'revision-1' } },
      state: 'continuation' as const,
      stage: 'settle' as const,
      errorMessage: 'workflow settlement remains partial',
      detail: 'durable continuation retained',
      retry: null,
      continuation: { kind: 'workflow-recovery.v1', key: 'workflow-1' },
      detectedAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:01.000Z',
    };
    const formatted = formatRecoveryQuarantineClear({
      boundary: continuation.boundary,
      key: continuation.subject.key,
      revision: continuation.subject.revision.value,
      disposition: 'continuation',
    });
    expect(formatted).toContain(`Run ${instruction}`);

    const clear = vi.fn();
    await programWith({ list: () => [continuation], clear }).parseAsync(['node', ...instruction.split(' ')]);

    expect(clear).not.toHaveBeenCalled();
    expect(stdout).toContain('state=continuation');
    expect(stdout).toContain('continuation_kind="workflow-recovery.v1"');
    expect(stderr).toBe('');
  });

  it('should accept a NUL-containing subject key exactly as list prints it', async () => {
    const key = `3a15866c\u00006e83e33f:0:0`;
    const entry = {
      boundary: 'session-retention-work',
      subject: { key, revision: { kind: 'fingerprint' as const, value: 'revision-1' } },
      state: 'active' as const,
      stage: 'settle' as const,
      errorMessage: 'Retention provider binding is unavailable',
      detail: 'P4 settle failed',
      retry: null,
      continuation: null,
      detectedAt: '2026-08-15T09:03:29.786Z',
      updatedAt: '2026-08-15T09:03:29.786Z',
    };

    const printed = formatRecoveryQuarantineList([entry]);
    const printedKey = /key=(rqk1-[0-9a-f]+)/u.exec(printed)?.[1];
    expect(printedKey, 'list must render one shell-safe key token').toBeDefined();
    expect(printedKey).not.toContain('\u0000');

    const clear = vi.fn(async (request: { boundary: string; key: string; revision: string | null }) => ({
      ...request,
      disposition: 'advanced' as const,
    }));
    await programWith({ list: () => [entry], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'session-retention-work',
      '--key',
      printedKey as string,
      '--revision',
      'fingerprint:sha256:revision-1',
    ]);

    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls[0]?.[0].key, 'the coordinator must receive the stored key, not its rendering').toBe(key);
  });

  it('should not accept shipped JSON quoting as an alternate encoding for a NUL-containing key', async () => {
    const clear = vi.fn();

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'session-retention-work',
      '--key',
      '"3a15866c\\u00006e83e33f:0:0"',
      '--revision',
      'fingerprint:sha256:revision-1',
    ]);

    expect(clear).not.toHaveBeenCalled();
    expect(stderr).toContain('keys containing NUL must use the encoded key printed');
  });

  it('should refuse clear when coordinator authority is unavailable', async () => {
    vi.spyOn(ipcEnsure, 'ensure').mockRejectedValue(new Error('connect ENOENT'));
    const recoveryQuarantine = createRecoveryQuarantineCommandOperations();
    vi.spyOn(recoveryQuarantine, 'list').mockReturnValue([]);
    const clear = vi.spyOn(recoveryQuarantine, 'clear');

    await programWith(recoveryQuarantine).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      encodeRecoveryQuarantineKey('workflow-1'),
      '--revision',
      'revision-1',
    ]);

    expect(clear).toHaveBeenCalledOnce();
    expect(stdout).toBe('');
    expect(stderr).toContain('Recovery quarantine mutation requires the canonical coordinator');
    expect(stderr).toContain('coral-cli backend status');
    expect(process.exitCode).toBe(69);
  });

  it('should use the ensured IPC catalog client for clear', async () => {
    const result = {
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
      disposition: 'advanced' as const,
    };
    const request = vi.fn().mockResolvedValue(result);
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({ request } as never);

    await expect(
      createRecoveryQuarantineCommandOperations().clear({
        boundary: 'workflow-recovery',
        key: 'workflow-1',
        revision: 'revision-1',
      }),
    ).resolves.toEqual(result);

    expect(request).toHaveBeenCalledWith(
      'coordinator.recovery_quarantine.clear',
      { boundary: 'workflow-recovery', key: 'workflow-1', revision: 'revision-1' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it.each([
    {
      name: 'method-not-found',
      respond: () => Promise.reject(new IpcRpcError({ code: -32601, message: 'Method not found' })),
      kind: 'unsupported-coordinator' as const,
    },
    {
      name: 'coordinator draining',
      respond: () => Promise.resolve({ code: 'backend_shutting_down', message: 'Backend shutting down' }),
      kind: 'coordinator-draining' as const,
    },
    {
      name: 'future exact-coordinate result',
      respond: () =>
        Promise.resolve({
          kind: 'discarded-with-audit',
          key: 'raw-key',
          revision: `sha256:${'a'.repeat(64)}`,
        }),
      kind: 'unsupported-coordinator-result' as const,
    },
    {
      name: 'timeout',
      respond: () => Promise.reject(new Error('IPC request timed out after 30000ms')),
      kind: 'timeout' as const,
    },
  ])('names discard $name as a typed no-verdict', async ({ respond, kind }) => {
    const request = vi.fn(respond);
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({ request } as never);
    const coordinate = { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}` };

    await expect(createRecoveryQuarantineCommandOperations().discardProviderOperation?.(coordinate)).resolves.toEqual({
      ...coordinate,
      kind,
    });
  });

  it('should report coordinator contract drift without calling it unreachable', async () => {
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({
      request: vi.fn().mockResolvedValue({ disposition: 'advanced' }),
    } as never);
    const recoveryQuarantine = createRecoveryQuarantineCommandOperations();
    vi.spyOn(recoveryQuarantine, 'list').mockReturnValue([]);

    await programWith(recoveryQuarantine).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      encodeRecoveryQuarantineKey('workflow-1'),
      '--revision',
      'revision-1',
    ]);

    expect(stderr).toContain('invalid recovery quarantine retry result');
    expect(stderr).not.toContain('not reachable');
  });

  it('should report an IPC timeout without calling it unreachable', async () => {
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({
      request: vi.fn().mockRejectedValue(new Error('IPC request timed out after 30000ms')),
    } as never);
    const recoveryQuarantine = createRecoveryQuarantineCommandOperations();
    vi.spyOn(recoveryQuarantine, 'list').mockReturnValue([]);

    await programWith(recoveryQuarantine).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'workflow-recovery',
      '--key',
      encodeRecoveryQuarantineKey('workflow-1'),
      '--revision',
      'revision-1',
    ]);

    expect(stderr).toContain('timed out before the coordinator returned a result');
    expect(stderr).not.toContain('not reachable');
  });

  it('should reject an invalid exact coordinate before invoking clear', async () => {
    const clear = vi.fn();

    await programWith({ list: () => [], clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      '',
      '--key',
      encodeRecoveryQuarantineKey('workflow-1'),
      '--revision',
      'revision-1',
    ]);

    expect(clear).not.toHaveBeenCalled();
    expect(stderr).toContain('Recovery boundary is required');
    expect(stderr).toContain('coral-cli backend recovery-quarantine list');
    expect(process.exitCode).toBe(2);
  });

  it('should wire registration, program construction, and command classes', () => {
    const coverage = collectCommandCoverage(buildProgram());
    const recoveryEntries = coverage
      .filter((entry) => entry.path.startsWith('backend recovery-quarantine'))
      .map((entry) => ({
        path: entry.path,
        isLeaf: entry.isLeaf,
        kind: entry.resolution.kind,
        commandClass: entry.resolution.kind === 'class' ? entry.resolution.commandClass : null,
      }));

    expect(recoveryEntries).toEqual([
      {
        path: 'backend recovery-quarantine',
        isLeaf: false,
        kind: 'container',
        commandClass: null,
      },
      {
        path: 'backend recovery-quarantine list',
        isLeaf: true,
        kind: 'class',
        commandClass: 'directRead',
      },
      {
        path: 'backend recovery-quarantine clear',
        isLeaf: true,
        kind: 'class',
        commandClass: 'mutate',
      },
      {
        path: 'backend recovery-quarantine discard-provider-operation',
        isLeaf: true,
        kind: 'class',
        commandClass: 'mutate',
      },
    ]);
  });
});
