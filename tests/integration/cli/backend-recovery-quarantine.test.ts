import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
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
import {
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryQuarantineClearRequest,
} from '#src/recovery/source-registry.js';
import { createUnreadableProviderOperationDiscardService } from '#src/coordinator/services/recovery/unreadable-provider-operation-discard.js';
import { sha256Hex } from '#src/infra/hash.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, classifyStoreFile } from '#src/store/db.js';
import { epochPath } from '#src/store/epoch.js';
import { MAX_SQLITE_DIAGNOSTIC_BYTES } from '#src/store/reset-incident.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
import { TOOL_TIMEOUT_MS } from '#src/transport/http/sse.js';
import { PROVIDER_OPERATION_RECORD_VERSION } from '#src/store/provider-operation-record.js';
import { encodeProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import * as ipcEnsure from '#src/transport/ipc/ensure.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import { executeRenderedCommand, operatorArtifactLines } from '#tests/helpers/rendered-command.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const storeReset: StoreResetCommandOperations = {
  list: () => ({ epochs: [], holders: [], residues: [], legacyIncidents: [], truncated: false }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
  release: async () => {
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

async function expectRenderedClearDispatch(rendered: string, expected: RecoveryQuarantineClearRequest): Promise<void> {
  let dispatched: RecoveryQuarantineClearRequest | undefined;
  const clear: RecoveryQuarantineCommandOperations['clear'] = async (request) => {
    dispatched = request;
    return { ...request, disposition: 'advanced' };
  };
  stdout = '';
  stderr = '';
  process.exitCode = undefined;

  await executeRenderedCommand(programWith({ list: () => [], clear }), rendered, {
    label: 'command',
    includes: 'recovery-quarantine clear',
  });

  expect(dispatched).toEqual(expected);
}

function publishCompatibleEpoch(runtime: ReturnType<typeof createRealRuntime>, epoch: string): void {
  const directory = join(runtime.paths.coral.store.dbDir, `epoch-${epoch}`);
  mkdirSync(directory, { recursive: true });
  openTestStoreDatabase({
    path: join(directory, 'store.db'),
    storage: runtime.storage,
    storeFormat: currentCoralStoreFormat(),
    flavor: runtime.flavor,
  }).close();
  publishEpochMetadata(runtime, epoch);
}

function publishEpochMetadata(runtime: ReturnType<typeof createRealRuntime>, epoch: string): void {
  const directory = join(runtime.paths.coral.store.dbDir, `epoch-${epoch}`);
  writeFileSync(join(directory, '.lock'), '');
  writeFileSync(
    join(directory, 'epoch.json'),
    `${JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable', cause: 'test publication' },
      build: {
        version: currentCoralStoreFormat().productVersion,
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        flavor: runtime.flavor,
        storeFormatFingerprint: currentCoralStoreFormat().fingerprint,
      },
      publishedAt: '2026-09-15T00:00:00.000Z',
    })}\n`,
  );
}

describe('backend recovery-quarantine commands', () => {
  it.each(['absent', 'empty'] as const)('prints an empty quarantine for an %s store root', async (state) => {
    const baseDir = mkdtempSync(join(tmpdir(), `coral-recovery-quarantine-${state}-`));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    if (state === 'empty') mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true });
    const clear: RecoveryQuarantineCommandOperations['clear'] = async (request) => ({
      ...request,
      disposition: 'advanced',
    });

    await programWith({ list: () => listRecoveryQuarantineLocal(runtime), clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'list',
    ]);

    console.log(
      `recovery-quarantine-${state}-cell output=${JSON.stringify(stdout.trim())} exit=${process.exitCode ?? 0}`,
    );
    expect(stdout).toBe('Recovery quarantine is empty.\n');
    expect(stderr).not.toContain('[code=internal]');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints a bounded disposition when the store exceeds the inspection budget', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-over-bound-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    publishCompatibleEpoch(runtime, '1');
    truncateSync(epochPath(runtime.paths.coral.store.dbDir, '1'), MAX_SQLITE_DIAGNOSTIC_BYTES + 1);
    const clear: RecoveryQuarantineCommandOperations['clear'] = async (request) => ({
      ...request,
      disposition: 'advanced',
    });

    await programWith({ list: () => listRecoveryQuarantineLocal(runtime), clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'list',
    ]);

    expect(stdout).toContain('exceeds the 256 MiB diagnostic bound');
    expect(stderr).not.toContain('[code=internal]');
    expect(process.exitCode).toBeUndefined();
  });

  it('prints an unobservable disposition when the current epoch proof is unreadable', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-unobservable-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    publishCompatibleEpoch(runtime, '1');
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          if (path.endsWith('epoch.json')) throw Object.assign(new Error('proof unreadable'), { code: 'EACCES' });
          return subject.readFileSync(path, encoding);
        };
      },
    });
    const clear: RecoveryQuarantineCommandOperations['clear'] = async (request) => ({
      ...request,
      disposition: 'advanced',
    });

    await programWith({ list: () => listRecoveryQuarantineLocal({ ...runtime, storage }), clear }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'list',
    ]);

    expect(stdout).toContain('could not be observed safely');
    expect(stderr).not.toContain('[code=internal]');
    expect(process.exitCode).toBeUndefined();
  });

  it('opens only a staged database copy while listing recovery quarantine', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-list-lock-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const dbDir = runtime.paths.coral.store.dbDir;
    publishCompatibleEpoch(runtime, '1');
    const livePath = epochPath(dbDir, '1');
    const openedPaths: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'openSqliteDatabaseSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, options?: { readOnly?: boolean }) => {
          openedPaths.push(path);
          return subject.openSqliteDatabaseSync(path, options);
        };
      },
    });

    expect(listRecoveryQuarantineLocal({ ...runtime, storage })).toEqual([]);
    expect(openedPaths.length).toBeGreaterThan(0);
    expect(openedPaths).not.toContain(livePath);
    console.log(
      `recovery-quarantine-copy-cell live-opens=${openedPaths.filter((path) => path === livePath).length} staged-opens=${openedPaths.length}`,
    );
  });

  it('should list retained rows directly while no daemon exists', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-cli-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const dbPath = epochPath(runtime.paths.coral.store.dbDir, '1');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openTestStoreDatabase({
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
    publishEpochMetadata(runtime, '1');

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
    expect(operatorArtifactLines(stdout)).toEqual([
      `clear=coral-cli backend recovery-quarantine clear --boundary "workflow-recovery" --key ${encodeRecoveryQuarantineKey('workflow-1')} --revision "fingerprint:revision-1"`,
      `clear=coral-cli backend recovery-quarantine clear --boundary "workflow-recovery" --key ${encodeRecoveryQuarantineKey('workflow-literal-sentinel')} --revision "fingerprint:until-cleared"`,
      `clear=coral-cli backend recovery-quarantine clear --boundary "workflow-recovery" --key ${encodeRecoveryQuarantineKey('workflow-unversioned')} --revision "until-cleared"`,
    ]);
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
    const dbPath = epochPath(runtime.paths.coral.store.dbDir, '1');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openTestStoreDatabase({
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
    publishEpochMetadata(runtime, '1');

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
    expect(operatorArtifactLines(rendered)).toEqual([]);
  });

  it.each([
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      labels: ['clear', 'discard'],
    },
    {
      state: 'retrying' as const,
      retry: { owner: 'retry-owner', token: 'retry-token' },
      continuation: null,
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      labels: [],
    },
    {
      state: 'continuation' as const,
      retry: null,
      continuation: { kind: 'provider-retry', key: 'continuation-key' },
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      labels: [],
    },
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: false,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      labels: [],
    },
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: true,
      revision: { kind: 'until-cleared' as const },
      key: 'provider_operation_saga.v1:record:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004',
      labels: ['clear'],
    },
    {
      state: 'active' as const,
      retry: null,
      continuation: null,
      persisted: true,
      revision: { kind: 'fingerprint' as const, value: `sha256:${'a'.repeat(64)}` },
      key: 'not-a-provider-operation-key',
      labels: ['clear'],
    },
  ])(
    'prints exactly $labels for $state persisted=$persisted evidence',
    ({ state, retry, continuation, persisted, revision, key, labels }) => {
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
          remedy: {
            kind: 'recovery-quarantine-discard',
            command: {
              kind: 'discard-provider-operation',
              key,
              revision: revision.kind === 'fingerprint' ? `fingerprint:${revision.value}` : 'until-cleared',
              allowReadable: false,
            },
          },
          detectedAt: persisted ? '2026-08-28T00:00:00.000Z' : null,
          updatedAt: persisted ? '2026-08-28T00:00:00.000Z' : null,
        },
      ]);
      const renderedLabels = operatorArtifactLines(rendered).map((line) => line.slice(0, line.indexOf('=')));
      expect(renderedLabels).toEqual(labels);
    },
  );

  it('should send the exact listed unreadable row revision to the destructive discard operation', async () => {
    const key =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      '00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:' +
      '00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004';
    const rawValue = 'not-json';
    const revision = `sha256:${sha256Hex(rawValue)}`;
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-discard-cli-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    mkdirSync(dirname(join(runtime.paths.coral.store.dbDir, 'store.db')), { recursive: true });
    const db = openTestStoreDatabase({
      path: join(runtime.paths.coral.store.dbDir, 'store.db'),
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
    });
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, rawValue);
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    const entry = {
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject: { key, revision: { kind: 'fingerprint' as const, value: revision } },
      state: 'active' as const,
      stage: 'hydrate' as const,
      errorMessage: 'unreadable',
      detail: 'discardable exact row',
      remedy: {
        kind: 'recovery-quarantine-discard' as const,
        command: {
          kind: 'discard-provider-operation' as const,
          key,
          revision: `fingerprint:${revision}`,
          allowReadable: false,
        },
      },
    };
    expect(quarantine.upsert(entry)).toBe(true);
    const discard = createUnreadableProviderOperationDiscardService({
      instanceId: 'listed-unreadable-discard',
      ids: runtime.ids,
      db,
      time: runtime.time,
    });
    const listing = formatRecoveryQuarantineList(quarantine.list());
    await executeRenderedCommand(
      programWith({
        list: () => quarantine.list(),
        clear: vi.fn(),
        discardProviderOperation: async (request) => discard.discard(request),
      }),
      listing,
      { label: 'discard', includes: encodeRecoveryQuarantineKey(key) },
    );

    expect(db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(key)).toBeUndefined();
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, key)).toBeNull();
    expect(stdout).toBe(`${formatUnreadableProviderOperationDiscard({ key, revision, kind: 'discarded' })}\n`);
    expect(stdout).toContain('permanently removed');
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
    db.close();
  });

  it('should require consent, then execute the complete readable-discard remedy from the listing', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-readable-cli-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    mkdirSync(dirname(join(runtime.paths.coral.store.dbDir, 'store.db')), { recursive: true });
    const db = openTestStoreDatabase({
      path: join(runtime.paths.coral.store.dbDir, 'store.db'),
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
    });
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const record = providerOperationRecord('executing');
    insertProviderOperation(db, record);
    const key =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      `${record.operation.jobId}:${record.operation.operationId}:` +
      `${record.operation.proxyInstanceId}:${record.operation.buildSetId}`;
    const revision = `sha256:${sha256Hex(encodeProviderOperationRecord(record))}`;
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    const entry = {
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject: { key, revision: { kind: 'fingerprint' as const, value: revision } },
      state: 'active' as const,
      stage: 'hydrate' as const,
      errorMessage: 'More than one readable provider operation row claims this job.',
      detail: 'Explicit consent is required before discarding this readable row.',
      remedy: {
        kind: 'recovery-quarantine-discard' as const,
        command: {
          kind: 'discard-provider-operation' as const,
          key,
          revision: `fingerprint:${revision}`,
          allowReadable: true,
        },
      },
    };
    expect(quarantine.upsert(entry)).toBe(true);
    const quarantineBefore = quarantine.list();
    const discard = createUnreadableProviderOperationDiscardService({
      instanceId: 'readable-no-consent',
      ids: runtime.ids,
      db,
      time: runtime.time,
    });
    type DiscardRequest = Parameters<NonNullable<RecoveryQuarantineCommandOperations['discardProviderOperation']>>[0];
    const discardRequests: DiscardRequest[] = [];
    const discardProviderOperation = async (request: DiscardRequest) => {
      discardRequests.push(request);
      return discard.discard(request);
    };

    await programWith({
      list: () => quarantine.list(),
      clear: vi.fn(),
      discardProviderOperation,
    }).parseAsync([
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

    expect(readProviderOperation(db, record.operation)).toEqual(record);
    expect(quarantine.list()).toEqual(quarantineBefore);
    expect(stderr).toContain('Readable provider-operation discard requires explicit consent');
    expect(discardRequests).toEqual([]);
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(2);

    stderr = '';
    process.exitCode = undefined;
    const tokens = await executeRenderedCommand(
      programWith({
        list: () => quarantine.list(),
        clear: vi.fn(),
        discardProviderOperation,
      }),
      formatRecoveryQuarantineList(quarantine.list()),
      { label: 'discard', includes: encodeRecoveryQuarantineKey(key) },
    );

    expect(tokens).toEqual([
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'discard-provider-operation',
      '--key',
      encodeRecoveryQuarantineKey(key),
      '--revision',
      `fingerprint:${revision}`,
      '--allow-readable',
    ]);
    expect(discardRequests).toEqual([{ key, revision, allowReadable: true }]);
    expect(readProviderOperation(db, record.operation)).toBeNull();
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, key)).toBeNull();
    expect(stdout).toContain(`key=${encodeRecoveryQuarantineKey(key)}`);
    expect(stdout).toContain(`revision=${JSON.stringify(`fingerprint:${revision}`)}`);
    expect(operatorArtifactLines(stdout)).toEqual([
      'command=coral-cli backend recovery-quarantine list',
      'command=coral-cli backend status',
    ]);
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
    db.close();
  });

  it('should refuse a retired tagged key at CLI ingress without calling the destructive operation', async () => {
    const key =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      '00000000-0000-4000-8000-000000000021:00000000-0000-4000-8000-000000000022:' +
      '00000000-0000-4000-8000-000000000023:00000000-0000-4000-8000-000000000024';
    const revision = `sha256:${'c'.repeat(64)}`;
    const discardProviderOperation: NonNullable<
      RecoveryQuarantineCommandOperations['discardProviderOperation']
    > = async () => {
      throw new Error('Malformed tagged key reached the destructive operation');
    };

    await programWith({ list: () => [], clear: vi.fn(), discardProviderOperation }).parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'discard-provider-operation',
      '--key',
      encodeRecoveryQuarantineKey(`readable-provider-operation\u0000${key}`),
      '--revision',
      `fingerprint:${revision}`,
    ]);

    expect(stderr).toContain('Invalid provider-operation coordinate');
    expect(process.exitCode).toBe(2);
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
    {
      result: {
        key: 'raw-key',
        revision: `sha256:${'a'.repeat(64)}`,
        kind: 'recovery-in-progress',
        code: 'backend_recovering',
        message: 'Provider-operation discard is unavailable while startup recovery owns the launch fence.',
        remedy: {
          kind: 'recovery-quarantine-discard',
          command: {
            kind: 'discard-provider-operation',
            key: 'raw-key',
            revision: `fingerprint:sha256:${'a'.repeat(64)}`,
            allowReadable: false,
          },
        },
      },
      exitCode: 75,
      stream: 'stderr',
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
        kind: 'adoption-refused',
        rowDisposition: 'discarded',
        releasedLaunchPermits: 0,
        refusals: [
          {
            recordKey: 'surviving-record-key',
            jobId: 'job-1',
            operationId: 'operation-1',
            proxyInstanceId: 'proxy-1',
            buildSetId: 'build-set-1',
            reason: 'the provider operation ownership path is not initialized',
            remedy: { kind: 'restart-coordinator' },
          },
        ],
      },
      exitCode: 75,
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
    type DiscardRequest = Parameters<NonNullable<RecoveryQuarantineCommandOperations['discardProviderOperation']>>[0];
    const discardRequests: DiscardRequest[] = [];
    const discardProviderOperation = vi.fn(async (request: DiscardRequest) => {
      discardRequests.push(request);
      return result;
    });
    const expectedRequest = { key: result.key, revision: result.revision };
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

    expect(discardRequests).toEqual([expectedRequest]);
    expect(process.exitCode).toBe(exitCode);
    const rendered = stream === 'stdout' ? stdout : stderr;
    expect(rendered).toContain(encodeRecoveryQuarantineKey(result.key));
    expect(rendered).toContain('Observed:');
    expect(rendered).toContain('Not observed:');
    expect(rendered).toContain('Effect:');
    expect(rendered).toContain('Next step:');
    expect(stream === 'stdout' ? stderr : stdout).toBe('');
    if (result.kind.includes('coordinator') || result.kind === 'timeout') {
      expect(stderr).toContain(`revision="fingerprint:${result.revision}"`);
      expect(stderr).toContain('No discard verdict');
    }
    if (result.kind === 'adoption-refused') {
      expect(stderr).toContain('startup ownership remains unresolved');
      expect(stderr).toContain(
        `record=${encodeRecoveryQuarantineKey('surviving-record-key')} job=job-1 operation=operation-1`,
      );
      expect(stderr).toContain('capacity remains held');
    }
    if (result.kind === 'recovery-in-progress') {
      expect(stderr).toContain('[backend_recovering]');
      const refusal = stderr;
      stderr = '';
      process.exitCode = undefined;
      await executeRenderedCommand(programWith({ list: () => [], clear: vi.fn(), discardProviderOperation }), refusal, {
        label: 'command',
      });
      expect(discardRequests).toEqual([expectedRequest, expectedRequest]);
      expect(stderr).toContain('[backend_recovering]');
      expect(stderr).toContain(encodeRecoveryQuarantineKey(result.key));
      expect(process.exitCode).toBe(75);
    }
    if (result.kind === 'readable') {
      await expectRenderedClearDispatch(stderr, {
        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
        key: result.key,
        revision: result.revision,
      });
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

  it('should refuse to call an unreadable older store an empty quarantine', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-recovery-quarantine-older-'));
    tempDirectories.push(baseDir);
    const runtime = createRealRuntime('prod', { baseDir });
    const current = currentCoralStoreFormat();
    const olderFormat: typeof current = {
      ...current,
      productVersion: '0.0.0-0',
      fingerprint: `sha256:${'0'.repeat(64)}`,
    };
    const db = openTestStoreDatabase({
      path: epochPath(runtime.paths.coral.store.dbDir, '1'),
      storage: runtime.storage,
      storeFormat: olderFormat,
      flavor: runtime.flavor,
    });
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_format_fingerprint'").run(olderFormat.fingerprint);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'store_product_version'").run(olderFormat.productVersion);
    db.close();
    publishEpochMetadata(runtime, '1');

    expect(
      classifyStoreFile(epochPath(runtime.paths.coral.store.dbDir, '1'), runtime.storage, currentCoralStoreFormat()),
    ).toMatchObject({ kind: 'older-incompatible' });
    // An older store is one this build cannot read, not one with nothing in it. Answering `[]` tells an
    // operator the rows they are looking for are gone.
    expect(() => listRecoveryQuarantineLocal(runtime)).toThrow(/older-incompatible/u);
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
    const db = openTestStoreDatabase({
      path: epochPath(runtime.paths.coral.store.dbDir, '1'),
      storage: runtime.storage,
      storeFormat: unsupportedFormat,
      flavor: runtime.flavor,
    });
    db.close();
    publishEpochMetadata(runtime, '1');

    expect(() => listRecoveryQuarantineLocal(runtime)).toThrow(
      /cannot be inspected while the local store is corrupt-or-unsupported.*coral-cli backend status/,
    );
  });

  it.each([
    ['advanced', 'resolved and removed', ''],
    ['quarantined', 'still quarantined', 'recovery-quarantine list'],
    ['continuation', 'partial progress', 'recovery-quarantine list'],
  ] as const)('should render %s as an actionable operator outcome', async (disposition, outcome, recovery) => {
    const formatted = formatRecoveryQuarantineClear({
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
      disposition,
    });

    expect(formatted).toContain(outcome);
    if (recovery.length > 0) {
      expect(formatted).toContain(recovery);
      await executeRenderedCommand(programWith({ list: () => [], clear: vi.fn() }), formatted, {
        label: 'command',
      });
      expect(stdout).toBe('Recovery quarantine is empty.\n');
    }
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
    expect(operatorArtifactLines(stdout)).toEqual(['command=coral-cli backend recovery-quarantine list']);
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
      remedy: null,
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
    const continuation = {
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-1', revision: { kind: 'fingerprint' as const, value: 'revision-1' } },
      state: 'continuation' as const,
      stage: 'settle' as const,
      errorMessage: 'workflow settlement remains partial',
      detail: 'durable continuation retained',
      remedy: null,
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

    const clear = vi.fn();
    await executeRenderedCommand(programWith({ list: () => [continuation], clear }), formatted, {
      label: 'command',
    });

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
      remedy: null,
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
    expect(operatorArtifactLines(stderr)).toEqual([
      'command=coral-cli backend status',
      `command=coral-cli backend recovery-quarantine clear --boundary "workflow-recovery" --key ${encodeRecoveryQuarantineKey('workflow-1')} --revision "revision-1"`,
    ]);
    expect(process.exitCode).toBe(69);
    await expectRenderedClearDispatch(stderr, {
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
    });
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
      name: 'known result without a coordinate',
      respond: () => Promise.resolve({ kind: 'discarded' }),
      kind: 'unsupported-coordinator-result' as const,
    },
    {
      name: 'result with malformed coordinates',
      respond: () => Promise.resolve({ kind: 'discarded', key: 42, revision: null }),
      kind: 'unsupported-coordinator-result' as const,
    },
    {
      name: 'result for a mismatched coordinate',
      respond: () =>
        Promise.resolve({
          kind: 'discarded',
          key: 'another-key',
          revision: `sha256:${'b'.repeat(64)}`,
        }),
      kind: 'unsupported-coordinator-result' as const,
    },
    {
      name: 'timeout',
      respond: () =>
        Promise.reject(
          Object.assign(new Error('Failed to connect to the Coral coordinator.'), {
            context: { cause: 'IPC connection deadline exceeded before retry' },
          }),
        ),
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
    expect(request).toHaveBeenCalledWith(
      'coordinator.recovery_quarantine.discard_provider_operation',
      coordinate,
      expect.objectContaining({ timeoutMs: TOOL_TIMEOUT_MS }),
    );
  });

  it('preserves a coordinator adoption refusal as the discard command result', async () => {
    const coordinate = { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}` };
    const refusal = {
      recordKey: 'surviving-record-key',
      jobId: '00000000-0000-4000-8000-000000000001',
      operationId: '00000000-0000-4000-8000-000000000002',
      proxyInstanceId: '00000000-0000-4000-8000-000000000003',
      buildSetId: '00000000-0000-4000-8000-000000000004',
      reason: 'the provider operation ownership path is not initialized',
      remedy: { kind: 'restart-coordinator' },
    };
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({
      request: vi.fn().mockResolvedValue({
        ...coordinate,
        kind: 'adoption-refused',
        rowDisposition: 'discarded',
        releasedLaunchPermits: 0,
        refusals: [refusal],
      }),
    } as never);

    await expect(createRecoveryQuarantineCommandOperations().discardProviderOperation?.(coordinate)).resolves.toEqual({
      ...coordinate,
      kind: 'adoption-refused',
      rowDisposition: 'discarded',
      releasedLaunchPermits: 0,
      refusals: [refusal],
    });
  });

  it('preserves a startup-recovery refusal as the discard command result', async () => {
    const coordinate = { key: 'raw-key', revision: `sha256:${'a'.repeat(64)}` };
    const refusal = {
      ...coordinate,
      kind: 'recovery-in-progress' as const,
      code: 'backend_recovering' as const,
      message: 'Provider-operation discard is unavailable while startup recovery owns the launch fence.',
      remedy: {
        kind: 'recovery-quarantine-discard',
        command: {
          kind: 'discard-provider-operation',
          key: coordinate.key,
          revision: `fingerprint:${coordinate.revision}`,
          allowReadable: false,
        },
      },
    };
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({
      request: vi.fn().mockResolvedValue(refusal),
    } as never);

    await expect(createRecoveryQuarantineCommandOperations().discardProviderOperation?.(coordinate)).resolves.toEqual(
      refusal,
    );
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
    await expectRenderedClearDispatch(stderr, {
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
    });
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
    await expectRenderedClearDispatch(stderr, {
      boundary: 'workflow-recovery',
      key: 'workflow-1',
      revision: 'revision-1',
    });
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
    expect(operatorArtifactLines(stderr)).toEqual(['command=coral-cli backend recovery-quarantine list']);
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
