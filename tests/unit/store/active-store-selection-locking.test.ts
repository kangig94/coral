import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as auditLogModule from '#src/infra/audit-log.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StorageBigIntStat, StorageEntryKind } from '#src/infra/port-types.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator } from '#src/infra/handoff-target.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  ACTIVE_STORE_SELECTION_VERSION,
  ACTIVE_STORE_TRANSITION_VERSION,
  encodeActiveStoreSelection,
  encodeActiveStoreTransition,
  readActiveStoreSelection,
  readActiveStoreTransition,
  resolveActiveStoreRecordPaths,
  type ActiveStoreSelection,
  type ActiveStoreTransition,
} from '#src/store/active-store-selection.js';
import { coordinateActiveStoreSelection } from '#src/store/active-store-selection-coordination.js';
import { createBackendStoreResetAuthority } from '#src/store/backend-store-reset.js';
import type { Database } from '#src/store/db.js';
import {
  resolveGenerationBoundaryPaths,
  type GenerationMaintenanceLease,
} from '#src/store/generation-mutation-coordination.js';
import type { StoreFormatClassification } from '#src/store/format-fingerprint.js';
import { STORE_RESET_MINTED_STORE_DIRECTORY, STORE_RESET_QUARANTINE_DIRECTORY } from '#src/store/reset-incident.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { spyOnClassifyStoreFile, spyOnOpenWritableStoreDatabase } from '#tests/helpers/store-db-spies.js';

const roots: string[] = [];
const backendBundle = 'backend fixture';
const cliBundle = 'cli fixture';
const claudeAppserverBundle = 'claude appserver fixture';
const durableWrapperBundle = 'durable wrapper fixture';

function bundleHash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

function manifest(version: string, buildSetId: string): StrictBundleManifest {
  return {
    version,
    buildSetId,
    bundleHash: bundleHash(backendBundle),
    cliBundleHash: bundleHash(cliBundle),
    claudeAppserverBundleHash: bundleHash(claudeAppserverBundle),
    durableWrapperBundleHash: bundleHash(durableWrapperBundle),
    flavor: 'prod',
    storeFormatFingerprint: currentCoralStoreFormat().fingerprint,
  };
}

function createBundle(root: string, expected: StrictBundleManifest): string {
  const bundleDir = join(root, `bundle-${expected.version}-${expected.buildSetId.slice(0, 8)}`);
  mkdirSync(bundleDir, { mode: 0o700 });
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle);
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle);
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle);
  writeFileSync(join(bundleDir, 'coral-durable-wrapper.cjs'), durableWrapperBundle);
  writeFileSync(join(bundleDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(expected));
  return bundleDir;
}

function selection(expected: StrictBundleManifest, bundleDir: string): ActiveStoreSelection {
  return {
    version: ACTIVE_STORE_SELECTION_VERSION,
    manifest: expected,
    bundleDir,
    activeStoreFingerprint: expected.storeFormatFingerprint,
  };
}

function harness(): {
  readonly root: string;
  readonly runtime: Runtime;
  readonly currentSelection: ActiveStoreSelection;
  readonly authority: ReturnType<typeof createBackendStoreResetAuthority>;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-selection-locking-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const currentManifest = manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000');
  const currentSelection = selection(currentManifest, createBundle(root, currentManifest));
  const authority = createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: false },
    {
      namespace: 'selection-lock-test',
      storeFormat: currentCoralStoreFormat(),
      build: currentManifest,
    },
  );
  return { root, runtime, currentSelection, authority };
}

function publish(runtime: Runtime, record: 'selectionFile' | 'transitionFile', bytes: Uint8Array): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.coordinationRoot, 0o700);
  expect(runtime.storage.writeAtomicDurableSync(paths[record], bytes, { mode: 0o600 })).toBe(true);
}

function fakeDatabase(): Database {
  return {
    exec: vi.fn(),
    close: vi.fn(),
  } as unknown as Database;
}

function stubStoreOpen(
  classification: StoreFormatClassification = { kind: 'fresh' },
  database: Database = fakeDatabase(),
): { readonly classifyStore: ReturnType<typeof vi.spyOn>; readonly openStore: ReturnType<typeof vi.spyOn> } {
  return {
    classifyStore: spyOnClassifyStoreFile().mockReturnValue(classification),
    openStore: spyOnOpenWritableStoreDatabase().mockImplementation(({ path }) => {
      if (!existsSync(path)) writeFileSync(path, '');
      return { kind: 'opened', db: database };
    }),
  };
}

function stubAudit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(auditLogModule, 'writeAuditEvent').mockImplementation(() => undefined);
}

async function immediateRecoveryLease(): Promise<GenerationMaintenanceLease> {
  return { assertOwned: () => undefined, maintain: () => undefined, release: () => undefined };
}

function supersededTransition(currentSelection: ActiveStoreSelection): ActiveStoreTransition {
  return {
    version: ACTIVE_STORE_TRANSITION_VERSION,
    transitionId: '323e4567-e89b-42d3-a456-426614174000',
    kind: 'selection-recovery',
    evidence: {
      kind: 'selection-absent',
      storeEvidence: { kind: 'pending-classification' },
    },
    currentManifest: manifest('0.9.0', '423e4567-e89b-42d3-a456-426614174000'),
    currentBundleDir: currentSelection.bundleDir,
  };
}

function retainedTransitionRoot(runtime: Runtime): string {
  return join(runtime.paths.coral.store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY, 'retained-active-store-transitions');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('active-store-selection locking', () => {
  it.each([
    { relation: 'exact', version: '1.0.0', buildSetId: '123e4567-e89b-42d3-a456-426614174000', writes: 0 },
    { relation: 'advance', version: '0.9.0', buildSetId: '223e4567-e89b-42d3-a456-426614174000', writes: 1 },
    { relation: 'equal-refresh', version: '1.0.0', buildSetId: '323e4567-e89b-42d3-a456-426614174000', writes: 1 },
  ] as const)(
    'should apply the $relation selection publication rule',
    async ({ relation, version, buildSetId, writes }) => {
      const { root, runtime, currentSelection, authority } = harness();
      const selectedManifest = manifest(version, buildSetId);
      const selected =
        relation === 'exact' ? currentSelection : selection(selectedManifest, createBundle(root, selectedManifest));
      publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));
      const paths = resolveActiveStoreRecordPaths(runtime);
      const durableWrite = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
      const selectionWrites: string[] = [];
      runtime.storage.writeAtomicDurableSync = (path, bytes, options) => {
        if (path === paths.selectionFile) selectionWrites.push(path);
        return durableWrite(path, bytes, options);
      };
      stubStoreOpen();

      const result = await coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          acquireStoreRecoveryLease: immediateRecoveryLease,
        },
      });

      expect(result.kind).toBe('opened');
      expect(selectionWrites).toHaveLength(writes);
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
    },
  );

  it('should publish transition then selection before opening an absent store without a reset lock', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o755 });
    chmodSync(paths.coordinationRoot, 0o755);
    const boundary = resolveGenerationBoundaryPaths(runtime);
    const resetLock = join(runtime.paths.coral.store.dbDir, 'store.db.reset.lock');
    const events: string[] = [];
    const durableWrite = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
    runtime.storage.writeAtomicDurableSync = vi.fn((path, bytes, options) => {
      expect(existsSync(boundary.adoptionLock)).toBe(true);
      if (path === paths.transitionFile || path === paths.selectionV1File || path === paths.selectionFile) {
        expect(existsSync(resetLock)).toBe(false);
        events.push(
          path === paths.transitionFile ? 'transition' : path === paths.selectionV1File ? 'selection-v1' : 'selection',
        );
      }
      return durableWrite(path, bytes, options);
    });
    const db = fakeDatabase();
    spyOnClassifyStoreFile().mockImplementation(() => {
      expect(existsSync(boundary.adoptionLock)).toBe(true);
      expect(existsSync(resetLock)).toBe(false);
      events.push('classify');
      return { kind: 'fresh' };
    });
    spyOnOpenWritableStoreDatabase().mockImplementation(({ path }) => {
      expect(existsSync(boundary.adoptionLock)).toBe(true);
      expect(existsSync(resetLock)).toBe(false);
      expect(path).not.toBe(runtime.paths.coral.store.dbFile);
      writeFileSync(path, '');
      events.push('open');
      return { kind: 'opened', db };
    });

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        acquireStoreRecoveryLease: immediateRecoveryLease,
      },
    });

    expect(result).toMatchObject({ kind: 'opened' });
    expect(events).toEqual(['transition', 'selection-v1', 'selection', 'open']);
    expect(existsSync(boundary.adoptionLock)).toBe(false);
    expect(existsSync(resetLock)).toBe(false);
    expect(statSync(paths.coordinationRoot).mode & 0o777).toBe(0o700);
    expect(statSync(paths.selectionV1File).mode & 0o777).toBe(0o600);
    expect(statSync(paths.selectionFile).mode & 0o777).toBe(0o600);
    expect(existsSync(paths.transitionV1File)).toBe(false);
    expect(existsSync(paths.transitionFile)).toBe(false);
  });

  it('should leave the store untouched when any required durable publication fails', async () => {
    for (const failedRecord of ['transitionFile', 'selectionV1File', 'selectionFile'] as const) {
      const { runtime, currentSelection, authority } = harness();
      const paths = resolveActiveStoreRecordPaths(runtime);
      const { classifyStore, openStore } = stubStoreOpen();
      classifyStore.mockClear();
      openStore.mockClear();
      const durableWrite = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
      runtime.storage.writeAtomicDurableSync = vi.fn((path, bytes, options) => {
        if (path === paths[failedRecord]) return false;
        return durableWrite(path, bytes, options);
      });

      await expect(
        coordinateActiveStoreSelection(runtime, authority, {
          storeFormat: currentCoralStoreFormat(),
          currentSelection,
          dependencies: {
            kind: 'operator',
            validateSelectedTarget: () => {
              throw new Error('validator should not run');
            },
          },
        }),
      ).rejects.toMatchObject({
        code: 'active_store_coordination_invalid',
        remediation: expect.stringContaining('Verify that'),
        context: expect.objectContaining({
          record: failedRecord === 'transitionFile' ? 'transition' : 'selection',
          failureCode: 'record_unavailable',
          cause: expect.stringContaining('published durably'),
        }),
      });

      expect(classifyStore).not.toHaveBeenCalled();
      expect(openStore).not.toHaveBeenCalled();
      expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
      if (failedRecord === 'selectionV1File' || failedRecord === 'selectionFile') {
        expect(readActiveStoreTransition(runtime).kind).toBe('valid');
      }
    }
  });

  it('should release adoption before returning a validated handoff without touching the store', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selected = selection(selectedManifest, createBundle(root, selectedManifest));
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));
    const boundary = resolveGenerationBoundaryPaths(runtime);
    const selectedBytes = readFileSync(resolveActiveStoreRecordPaths(runtime).selectionFile);
    const classifyStore = spyOnClassifyStoreFile();
    const openStore = spyOnOpenWritableStoreDatabase();
    const validate = createForeignTargetValidator();

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: (bundleDir, expectedManifest) => {
          expect(existsSync(boundary.adoptionLock)).toBe(true);
          return validate(bundleDir, expectedManifest);
        },
      },
    });

    expect(result.kind).toBe('handoff');
    expect(existsSync(boundary.adoptionLock)).toBe(false);
    expect(classifyStore).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
    expect(readFileSync(resolveActiveStoreRecordPaths(runtime).selectionFile)).toEqual(selectedBytes);
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
  });

  it('should resume a transition even when the selection already names the current build', async () => {
    const { runtime, currentSelection, authority } = harness();
    const transition: ActiveStoreTransition = {
      version: ACTIVE_STORE_TRANSITION_VERSION,
      transitionId: '323e4567-e89b-42d3-a456-426614174000',
      kind: 'selection-recovery',
      evidence: {
        kind: 'selection-malformed',
        selectionByteLength: 8,
        selectionSha256: 'a'.repeat(64),
        failureCode: 'selection_invalid_json',
        storeEvidence: { kind: 'pending-classification' },
      },
      currentManifest: currentSelection.manifest,
      currentBundleDir: currentSelection.bundleDir,
    };
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(transition));
    const db = fakeDatabase();
    const storeFormat = currentCoralStoreFormat();
    stubStoreOpen(
      {
        kind: 'compatible',
        currentFingerprint: storeFormat.fingerprint,
        currentProductVersion: currentSelection.manifest.version,
        storedFingerprint: storeFormat.fingerprint,
        storedProductVersion: currentSelection.manifest.version,
      },
      db,
    );
    const recordAudit = stubAudit();

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat,
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        acquireStoreRecoveryLease: immediateRecoveryLease,
      },
    });

    expect(result).toMatchObject({ kind: 'opened' });
    expect(recordAudit).toHaveBeenCalledWith(
      'invalid-selection-recovery',
      expect.objectContaining({ transitionId: transition.transitionId }),
      'warn',
    );
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });

  it.each(['record_changed', 'record_unavailable'] as const)(
    'should supersede and recover from a transition read rejected as %s',
    async (failureCode) => {
      const { runtime, currentSelection, authority } = harness();
      const paths = resolveActiveStoreRecordPaths(runtime);
      publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
      publish(runtime, 'transitionFile', encodeActiveStoreTransition(supersededTransition(currentSelection)));
      if (failureCode === 'record_changed') {
        const readSync = runtime.storage.readSync.bind(runtime.storage);
        let rejectRead = true;
        runtime.storage.readSync = (descriptor, buffer, offset, length, position) => {
          if (rejectRead) {
            rejectRead = false;
            return 0;
          }
          return readSync(descriptor, buffer, offset, length, position);
        };
      } else {
        const lstatSync = runtime.storage.lstatSync.bind(runtime.storage);
        let rejectStat = true;
        function rejectTransitionStat(path: string): StorageEntryKind;
        function rejectTransitionStat(path: string, options: { bigint: true }): StorageBigIntStat;
        function rejectTransitionStat(path: string, options?: { bigint: true }): StorageEntryKind | StorageBigIntStat {
          if (path === paths.transitionFile && rejectStat) {
            rejectStat = false;
            throw Object.assign(new Error('transition stat unavailable'), { code: 'EACCES' });
          }
          return options?.bigint === true ? lstatSync(path, options) : lstatSync(path);
        }
        runtime.storage.lstatSync = rejectTransitionStat;
      }
      const db = fakeDatabase();
      stubStoreOpen({ kind: 'fresh' }, db);
      const recordAudit = stubAudit();

      const result = await coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          acquireStoreRecoveryLease: immediateRecoveryLease,
        },
      });

      expect(result).toMatchObject({ kind: 'opened' });
      expect(recordAudit).toHaveBeenCalledWith(
        'active-store-transition-superseded',
        expect.objectContaining({ failureCode }),
        'warn',
      );
      expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
      expect(readdirSync(retainedTransitionRoot(runtime))).toHaveLength(1);
    },
  );

  it('should transfer a v1-only transition to quarantine before clearing its rollback authority', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    const legacy = supersededTransition(currentSelection);
    const currentManifestV1 = {
      version: legacy.currentManifest.version,
      buildSetId: legacy.currentManifest.buildSetId,
      bundleHash: legacy.currentManifest.bundleHash,
      cliBundleHash: legacy.currentManifest.cliBundleHash,
      claudeAppserverBundleHash: legacy.currentManifest.claudeAppserverBundleHash,
      flavor: legacy.currentManifest.flavor,
      storeFormatFingerprint: legacy.currentManifest.storeFormatFingerprint,
    };
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
    const legacyBytes = `${JSON.stringify({ ...legacy, version: 1, currentManifest: currentManifestV1 })}\n`;
    writeFileSync(paths.transitionV1File, legacyBytes, { mode: 0o600 });
    const unlink = runtime.storage.unlinkSync.bind(runtime.storage);
    runtime.storage.unlinkSync = vi.fn((path) => {
      if (path === paths.transitionV1File) {
        expect(readdirSync(retainedTransitionRoot(runtime))).toHaveLength(1);
      }
      unlink(path);
    });
    const db = fakeDatabase();
    stubStoreOpen({ kind: 'fresh' }, db);
    const recordAudit = stubAudit();

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        acquireStoreRecoveryLease: immediateRecoveryLease,
      },
    });

    expect(result).toMatchObject({ kind: 'opened' });
    expect(existsSync(paths.transitionV1File)).toBe(false);
    const retainedFiles = readdirSync(retainedTransitionRoot(runtime));
    expect(retainedFiles).toHaveLength(1);
    expect(readFileSync(join(retainedTransitionRoot(runtime), retainedFiles[0]), 'utf8')).toBe(legacyBytes);
    expect(recordAudit).toHaveBeenCalledWith(
      'active-store-transition-superseded',
      expect.objectContaining({ failureCode: 'transition_current_build_mismatch' }),
      'warn',
    );
  });

  it('should hard-refuse a transition rejection outside the supersede allowlist', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    mkdirSync(paths.transitionFile, { mode: 0o700 });
    const classifyStore = spyOnClassifyStoreFile();
    const openStore = spyOnOpenWritableStoreDatabase();

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      context: { record: 'transition', failureCode: 'record_not_regular' },
    });
    expect(classifyStore).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
    expect(existsSync(retainedTransitionRoot(runtime))).toBe(false);
  });

  it('should continue when a rejected transition disappears before retention', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(supersededTransition(currentSelection)));
    const lstatSync = runtime.storage.lstatSync.bind(runtime.storage);
    let removeBeforeRetention = true;
    function removeBeforeTransitionRetention(path: string): StorageEntryKind;
    function removeBeforeTransitionRetention(path: string, options: { bigint: true }): StorageBigIntStat;
    function removeBeforeTransitionRetention(
      path: string,
      options?: { bigint: true },
    ): StorageEntryKind | StorageBigIntStat {
      if (path === paths.transitionFile && removeBeforeRetention) {
        removeBeforeRetention = false;
        runtime.storage.unlinkSync(path);
        throw Object.assign(new Error('transition disappeared'), { code: 'EACCES' });
      }
      return options?.bigint === true ? lstatSync(path, options) : lstatSync(path);
    }
    runtime.storage.lstatSync = removeBeforeTransitionRetention;
    const db = fakeDatabase();
    stubStoreOpen({ kind: 'fresh' }, db);
    const recordAudit = stubAudit();

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        acquireStoreRecoveryLease: immediateRecoveryLease,
      },
    });

    expect(result).toMatchObject({ kind: 'opened' });
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(existsSync(retainedTransitionRoot(runtime))).toBe(false);
    expect(recordAudit).toHaveBeenCalledWith(
      'active-store-transition-superseded',
      expect.not.objectContaining({ evidencePath: expect.anything() }),
      'warn',
    );
  });

  it('should refuse a non-missing transition copy failure', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(supersededTransition(currentSelection)));
    const openSync = runtime.storage.openSync.bind(runtime.storage);
    let transitionReadCount = 0;
    runtime.storage.openSync = (path, flags, mode) => {
      if (path === paths.transitionFile && flags === 'r') {
        transitionReadCount += 1;
        if (transitionReadCount === 2) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
      }
      return openSync(path, flags, mode);
    };

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'store_reset_quarantine_failed',
      context: { reason: 'active_store_transition_evidence' },
    });
    expect(readActiveStoreTransition(runtime).kind).toBe('valid');
  });

  it('should report clear failures without duplicating retained evidence on restart', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(supersededTransition(currentSelection)));
    const unlinkSync = runtime.storage.unlinkSync.bind(runtime.storage);
    runtime.storage.unlinkSync = (path) => {
      if (path === paths.transitionFile) {
        throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      }
      unlinkSync(path);
    };
    const recordAudit = stubAudit();
    const options = {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator' as const,
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
      },
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(coordinateActiveStoreSelection(runtime, authority, options)).rejects.toMatchObject({
        code: 'active_store_coordination_invalid',
        context: expect.objectContaining({
          record: 'transition',
          failureCode: 'record_unavailable',
          cause: 'permission denied',
        }),
      });
      expect(readdirSync(retainedTransitionRoot(runtime))).toHaveLength(1);
    }
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('should wrap a failed transition-clear directory sync in the coordination refusal', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(supersededTransition(currentSelection)));
    const syncDirectory = runtime.storage.syncDirectoryDurableSync.bind(runtime.storage);
    runtime.storage.syncDirectoryDurableSync = (path) =>
      path === paths.coordinationRoot ? false : syncDirectory(path);

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      context: expect.objectContaining({
        record: 'transition',
        failureCode: 'record_unavailable',
        cause: 'Active-store transition clear could not be synchronized durably.',
      }),
    });
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });

  it('should surface record_changed when the transition file changes identity before durable clear', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(supersededTransition(currentSelection)));
    const renameSync = runtime.storage.renameSync.bind(runtime.storage);
    const retainedRoot = retainedTransitionRoot(runtime);
    let retentionCommitted = false;
    runtime.storage.renameSync = (oldPath, newPath) => {
      renameSync(oldPath, newPath);
      // `acquireGenerationAdoptionLock` also renames as part of its own directory-lock protocol, so the gate
      // must be the retained-evidence commit specifically, not "any rename has happened yet".
      if (newPath.startsWith(retainedRoot)) {
        retentionCommitted = true;
      }
    };
    const stat = runtime.storage.statSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'statSync').mockImplementation((target, options) => {
      const result = stat(target, options);
      // Retention captures the transition file's identity through an open descriptor before this point, so
      // poisoning only starts once its evidence copy is committed — leaving `clearActiveStoreTransition`'s
      // own recheck as the sole remaining bigint stat on this path, simulating the file changing identity
      // between retention and durable clear.
      if (retentionCommitted && target === paths.transitionFile && options?.bigint === true) {
        return {
          ...result,
          mtimeNs: (result as { mtimeNs: bigint }).mtimeNs + 1n,
          isDirectory: () => result.isDirectory(),
          isFile: () => result.isFile(),
        };
      }
      return result;
    });

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      context: expect.objectContaining({
        record: 'transition',
        failureCode: 'record_changed',
        cause: 'Active-store transition changed before durable clear.',
      }),
    });
    expect(readdirSync(retainedTransitionRoot(runtime))).toHaveLength(1);
  });

  it('should await the operator recovery lease before opening a store that needs reset', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true, mode: 0o700 });
    writeFileSync(runtime.paths.coral.store.dbFile, 'store requiring reset');
    let grantLease: (lease: GenerationMaintenanceLease) => void = () => {
      throw new Error('recovery lease resolver was not initialized');
    };
    const pendingLease = new Promise<GenerationMaintenanceLease>((resolve) => {
      grantLease = resolve;
    });
    const acquireStoreRecoveryLease = vi.fn(() => pendingLease);
    const assertOwned = vi.fn();
    const release = vi.fn();
    const db = fakeDatabase();
    const storeFormat = currentCoralStoreFormat();
    const { classifyStore, openStore } = stubStoreOpen({ kind: 'fresh' }, db);
    const resetClassification = {
      kind: 'older-incompatible',
      currentFingerprint: storeFormat.fingerprint,
      currentProductVersion: storeFormat.productVersion,
      storedFingerprint: `sha256:${'0'.repeat(64)}`,
      storedProductVersion: '0.0.0',
    } as const;
    classifyStore.mockReturnValueOnce(resetClassification).mockReturnValueOnce(resetClassification);

    const coordinating = coordinateActiveStoreSelection(runtime, authority, {
      storeFormat,
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        acquireStoreRecoveryLease,
      },
    });
    await vi.waitFor(() => expect(acquireStoreRecoveryLease).toHaveBeenCalledOnce());
    expect(openStore).not.toHaveBeenCalled();

    grantLease({ assertOwned, maintain: () => undefined, release });
    await expect(coordinating).resolves.toMatchObject({ kind: 'opened' });
    expect(assertOwned).toHaveBeenCalled();
    expect(openStore).toHaveBeenCalledTimes(2);
    for (const callOrder of openStore.mock.invocationCallOrder) {
      expect(assertOwned.mock.invocationCallOrder[0]).toBeLessThan(callOrder);
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it('should treat a store deleted after its initial lstat as absent', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true, mode: 0o700 });
    writeFileSync(runtime.paths.coral.store.dbFile, 'disappearing store');
    const lstatSync = runtime.storage.lstatSync.bind(runtime.storage);
    let deleteAfterInitialStat = true;
    function deleteStoreAfterInitialStat(path: string): StorageEntryKind;
    function deleteStoreAfterInitialStat(path: string, options: { bigint: true }): StorageBigIntStat;
    function deleteStoreAfterInitialStat(
      path: string,
      options?: { bigint: true },
    ): StorageEntryKind | StorageBigIntStat {
      const result = options?.bigint === true ? lstatSync(path, options) : lstatSync(path);
      if (path === runtime.paths.coral.store.dbFile && options === undefined && deleteAfterInitialStat) {
        deleteAfterInitialStat = false;
        runtime.storage.unlinkSync(path);
      }
      return result;
    }
    runtime.storage.lstatSync = deleteStoreAfterInitialStat;
    const db = fakeDatabase();
    const openStore = spyOnOpenWritableStoreDatabase().mockImplementation(({ path }) => {
      if (!existsSync(path)) writeFileSync(path, '');
      return { kind: 'opened', db };
    });
    const acquireStoreRecoveryLease = vi.fn(immediateRecoveryLease);

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          acquireStoreRecoveryLease,
        },
      }),
    ).resolves.toMatchObject({ kind: 'opened' });

    expect(deleteAfterInitialStat).toBe(false);
    expect(acquireStoreRecoveryLease).toHaveBeenCalledOnce();
    expect(openStore).toHaveBeenCalledOnce();
  });

  it('should reset a symlink swapped in after the initial lstat instead of adopting its target', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    const storeFormat = currentCoralStoreFormat();
    mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true, mode: 0o700 });
    writeFileSync(runtime.paths.coral.store.dbFile, 'regular store before swap');
    const externalPath = join(root, 'external-legacy.db');
    const external = runtime.storage.openSqliteDatabaseSync(externalPath);
    external.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    external
      .prepare("INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', ?)")
      .run(storeFormat.fingerprint);
    external.close();
    const lstatSync = runtime.storage.lstatSync.bind(runtime.storage);
    let swapAfterInitialStat = true;
    function swapStoreAfterInitialStat(path: string): StorageEntryKind;
    function swapStoreAfterInitialStat(path: string, options: { bigint: true }): StorageBigIntStat;
    function swapStoreAfterInitialStat(path: string, options?: { bigint: true }): StorageEntryKind | StorageBigIntStat {
      const result = options?.bigint === true ? lstatSync(path, options) : lstatSync(path);
      if (path === runtime.paths.coral.store.dbFile && options === undefined && swapAfterInitialStat) {
        swapAfterInitialStat = false;
        runtime.storage.unlinkSync(path);
        symlinkSync(externalPath, path);
      }
      return result;
    }
    runtime.storage.lstatSync = swapStoreAfterInitialStat;
    const db = fakeDatabase();
    const openStore = spyOnOpenWritableStoreDatabase().mockImplementation(({ path }) => {
      if (!existsSync(path)) writeFileSync(path, '');
      return { kind: 'opened', db };
    });
    const acquireStoreRecoveryLease = vi.fn(immediateRecoveryLease);

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat,
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          acquireStoreRecoveryLease,
        },
      }),
    ).resolves.toMatchObject({ kind: 'opened' });

    expect(swapAfterInitialStat).toBe(false);
    expect(acquireStoreRecoveryLease).toHaveBeenCalledOnce();
    expect(openStore).toHaveBeenCalledOnce();
    const externalAfter = runtime.storage.openSqliteDatabaseSync(externalPath, { readOnly: true });
    expect(externalAfter.prepare("SELECT value FROM meta WHERE key = 'store_format_fingerprint'").get()).toEqual({
      value: storeFormat.fingerprint,
    });
    externalAfter.close();
  });

  it('should refuse a real legacy store after recovery exclusion and parked-inode classification', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    const storeFormat = currentCoralStoreFormat();
    mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true, mode: 0o700 });
    const legacy = runtime.storage.openSqliteDatabaseSync(runtime.paths.coral.store.dbFile);
    legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    legacy.prepare("INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', ?)").run(storeFormat.fingerprint);
    legacy.close();
    const openStore = spyOnOpenWritableStoreDatabase();
    const acquireStoreRecoveryLease = vi.fn(immediateRecoveryLease);

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat,
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          acquireStoreRecoveryLease,
        },
      }),
    ).rejects.toMatchObject({ code: 'store_schema_outdated' });

    expect(openStore).toHaveBeenCalledOnce();
    expect(openStore).toHaveBeenCalledWith(
      expect.objectContaining({
        path: join(
          runtime.paths.coral.store.dbDir,
          'store-reset-quarantine',
          '.minted',
          STORE_RESET_MINTED_STORE_DIRECTORY,
          'store.db',
        ),
      }),
    );
    expect(acquireStoreRecoveryLease).toHaveBeenCalledOnce();
  });

  it('should report a record trust violation before trying to acquire a recovery lease', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
    mkdirSync(paths.selectionFile, { mode: 0o700 });
    const acquireStoreRecoveryLease = vi.fn(async () => {
      throw new Error('maintenance lease must not replace the record refusal');
    });

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          acquireStoreRecoveryLease,
        },
      }),
    ).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      userMessage: 'Coral cannot safely use the active-store selection record.',
      remediation: expect.not.stringContaining('build that owns this coordination state'),
      context: { record: 'selection', failureCode: 'record_not_regular' },
    });
    expect(acquireStoreRecoveryLease).not.toHaveBeenCalled();
  });

  it('should refuse an in-memory path before creating any coordination or reset lock', async () => {
    const { runtime, currentSelection } = harness();
    const authority = createBackendStoreResetAuthority(
      runtime,
      { acquiredViaHandoff: false },
      {
        path: ':memory:',
        namespace: 'selection-memory-test',
        storeFormat: currentCoralStoreFormat(),
        build: currentSelection.manifest,
      },
    );
    const mkdirSync = vi.spyOn(runtime.storage, 'mkdirSync');

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        path: ':memory:',
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'startup',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          acquireWriterExclusion: async () => ({ kind: 'unproven', reason: 'lock-timeout', blockers: null }),
        },
      }),
    ).rejects.toThrow('requires a real filesystem store path');

    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('should refuse via the documented code when a freshly created coordination directory is unsafe', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    const mkdirSync = runtime.storage.mkdirSync.bind(runtime.storage);
    let coordinationRootCreated = false;
    runtime.storage.mkdirSync = (path, options) => {
      mkdirSync(path, options);
      if (path === paths.coordinationRoot) coordinationRootCreated = true;
    };
    const lstatSync = runtime.storage.lstatSync.bind(runtime.storage);
    function poisonCreatedCoordinationRoot(path: string): StorageEntryKind;
    function poisonCreatedCoordinationRoot(path: string, options: { bigint: true }): StorageBigIntStat;
    function poisonCreatedCoordinationRoot(
      path: string,
      options?: { bigint: true },
    ): StorageEntryKind | StorageBigIntStat {
      if (path === paths.coordinationRoot && coordinationRootCreated) {
        coordinationRootCreated = false;
        const real = options?.bigint === true ? lstatSync(path, options) : lstatSync(path);
        return { ...real, isDirectory: () => true, isSymbolicLink: () => true };
      }
      return options?.bigint === true ? lstatSync(path, options) : lstatSync(path);
    }
    runtime.storage.lstatSync = poisonCreatedCoordinationRoot;

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      remediation: expect.stringContaining('as an ordinary canonical directory'),
      context: expect.objectContaining({ record: 'transition', failureCode: 'coordination_directory_link' }),
    });
  });

  it('should refuse via the documented code when the coordination directory fails its durable-write recheck', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
    chmodSync(paths.coordinationRoot, 0o700);
    const lstatSync = runtime.storage.lstatSync.bind(runtime.storage);
    let transitionPublicationReady = false;
    function armTransitionPublicationRecheck(path: string): StorageEntryKind;
    function armTransitionPublicationRecheck(path: string, options: { bigint: true }): StorageBigIntStat;
    function armTransitionPublicationRecheck(
      path: string,
      options?: { bigint: true },
    ): StorageEntryKind | StorageBigIntStat {
      if (path === paths.selectionFile) transitionPublicationReady = true;
      return options?.bigint === true ? lstatSync(path, options) : lstatSync(path);
    }
    runtime.storage.lstatSync = armTransitionPublicationRecheck;
    const realpathSync = runtime.storage.realpathSync.bind(runtime.storage);
    runtime.storage.realpathSync = (path) => {
      if (path === paths.coordinationRoot && transitionPublicationReady) {
        transitionPublicationReady = false;
        return `${path}-mismatch`;
      }
      return realpathSync(path);
    };

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      remediation: expect.stringContaining('as an ordinary canonical directory'),
      context: expect.objectContaining({ record: 'transition', failureCode: 'coordination_directory_not_canonical' }),
    });
  });

  it('should refuse via the documented code when the coordination directory mode cannot be restored', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o755 });
    chmodSync(paths.coordinationRoot, 0o755);
    const chmodSyncPort = runtime.storage.chmodSync.bind(runtime.storage);
    runtime.storage.chmodSync = (path, mode) => {
      // Simulate a chmod that reports success but never takes effect (e.g. a filesystem that ignores
      // permission bits): `ensureActiveStoreCoordinationDirectory` must catch the drift rather than trust it.
      if (path === paths.coordinationRoot) return;
      chmodSyncPort(path, mode);
    };

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      remediation: expect.stringContaining('as an ordinary canonical directory'),
      context: expect.objectContaining({ record: 'transition', failureCode: 'coordination_directory_not_canonical' }),
    });
  });
});
