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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator } from '#src/infra/handoff-target.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  encodeActiveStoreSelection,
  encodeActiveStoreTransition,
  readActiveStoreSelection,
  readActiveStoreTransition,
  resolveActiveStoreRecordPaths,
  type ActiveStoreSelection,
  type ActiveStoreTransition,
} from '#src/store/active-store-selection.js';
import {
  coordinateActiveStoreSelection,
  type ActiveStoreSelectionRecoveryLease,
} from '#src/store/active-store-selection-coordination.js';
import { createBackendStoreResetAuthority } from '#src/store/backend-store-reset.js';
import type { Database } from '#src/store/db.js';
import {
  resolveGenerationBoundaryPaths,
  type GenerationAdoptionLockLease,
} from '#src/store/generation-mutation-coordination.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from '#src/store/reset-incident.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const roots: string[] = [];
const backendBundle = 'backend fixture';
const cliBundle = 'cli fixture';
const claudeAppserverBundle = 'claude appserver fixture';

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
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(expected));
  return bundleDir;
}

function selection(expected: StrictBundleManifest, bundleDir: string): ActiveStoreSelection {
  return {
    version: 1,
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

function supersededTransition(currentSelection: ActiveStoreSelection): ActiveStoreTransition {
  return {
    version: 1,
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

      const result = await coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          classifyStore: () => ({ kind: 'fresh' }),
          openStore: () => fakeDatabase(),
        },
      });

      expect(result.kind).toBe('opened');
      expect(selectionWrites).toHaveLength(writes);
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
    },
  );

  it('should publish transition then selection before taking the reset lock and opening the store', async () => {
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
      expect(existsSync(resetLock)).toBe(false);
      events.push(path === paths.transitionFile ? 'transition' : 'selection');
      return durableWrite(path, bytes, options);
    });
    const db = fakeDatabase();

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        classifyStore: () => {
          expect(existsSync(boundary.adoptionLock)).toBe(true);
          expect(existsSync(resetLock)).toBe(true);
          events.push('classify');
          return { kind: 'fresh' };
        },
        openStore: () => {
          expect(existsSync(boundary.adoptionLock)).toBe(true);
          expect(existsSync(resetLock)).toBe(true);
          events.push('open');
          return db;
        },
      },
    });

    expect(result).toEqual({ kind: 'opened', db });
    expect(events).toEqual(['transition', 'selection', 'classify', 'open']);
    expect(existsSync(boundary.adoptionLock)).toBe(false);
    expect(existsSync(resetLock)).toBe(false);
    expect(statSync(paths.coordinationRoot).mode & 0o777).toBe(0o700);
    expect(statSync(paths.selectionFile).mode & 0o777).toBe(0o600);
    expect(existsSync(paths.transitionFile)).toBe(false);
  });

  it('should leave the store untouched when either required durable publication fails', async () => {
    for (const failedRecord of ['transitionFile', 'selectionFile'] as const) {
      const { runtime, currentSelection, authority } = harness();
      const paths = resolveActiveStoreRecordPaths(runtime);
      const classifyStore = vi.fn(() => ({ kind: 'fresh' as const }));
      const openStore = vi.fn(() => fakeDatabase());
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
            classifyStore,
            openStore,
          },
        }),
      ).rejects.toThrow(/published durably/u);

      expect(classifyStore).not.toHaveBeenCalled();
      expect(openStore).not.toHaveBeenCalled();
      expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
      if (failedRecord === 'selectionFile') {
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
    const classifyStore = vi.fn();
    const openStore = vi.fn();
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
        classifyStore,
        openStore,
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
      version: 1,
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
    const recordAudit = vi.fn();
    const db = fakeDatabase();
    const storeFormat = currentCoralStoreFormat();

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat,
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        classifyStore: () => ({
          kind: 'compatible',
          currentFingerprint: storeFormat.fingerprint,
          currentProductVersion: currentSelection.manifest.version,
          storedFingerprint: storeFormat.fingerprint,
          storedProductVersion: currentSelection.manifest.version,
        }),
        openStore: () => db,
        recordAudit,
      },
    });

    expect(result).toEqual({ kind: 'opened', db });
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
        runtime.storage.lstatSync = (path) => {
          if (path === paths.transitionFile && rejectStat) {
            rejectStat = false;
            throw Object.assign(new Error('transition stat unavailable'), { code: 'EACCES' });
          }
          return lstatSync(path);
        };
      }
      const recordAudit = vi.fn();
      const db = fakeDatabase();

      const result = await coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          classifyStore: () => ({ kind: 'fresh' }),
          openStore: () => db,
          recordAudit,
        },
      });

      expect(result).toEqual({ kind: 'opened', db });
      expect(recordAudit).toHaveBeenCalledWith(
        'active-store-transition-superseded',
        expect.objectContaining({ failureCode }),
        'warn',
      );
      expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
      expect(readdirSync(retainedTransitionRoot(runtime))).toHaveLength(1);
    },
  );

  it('should hard-refuse a transition rejection outside the supersede allowlist', async () => {
    const { runtime, currentSelection, authority } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    mkdirSync(paths.transitionFile, { mode: 0o700 });
    const classifyStore = vi.fn();
    const openStore = vi.fn();

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: {
          kind: 'operator',
          validateSelectedTarget: () => {
            throw new Error('validator should not run');
          },
          classifyStore,
          openStore,
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
    runtime.storage.lstatSync = (path) => {
      if (path === paths.transitionFile && removeBeforeRetention) {
        removeBeforeRetention = false;
        runtime.storage.unlinkSync(path);
        throw Object.assign(new Error('transition disappeared'), { code: 'EACCES' });
      }
      return lstatSync(path);
    };
    const recordAudit = vi.fn();
    const db = fakeDatabase();

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        classifyStore: () => ({ kind: 'fresh' }),
        openStore: () => db,
        recordAudit,
      },
    });

    expect(result).toEqual({ kind: 'opened', db });
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
    const recordAudit = vi.fn();
    const options = {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator' as const,
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        recordAudit,
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

  it('should await the operator recovery lease before opening the prepared store', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    let grantLease: (lease: ActiveStoreSelectionRecoveryLease) => void = () => {
      throw new Error('recovery lease resolver was not initialized');
    };
    const pendingLease = new Promise<ActiveStoreSelectionRecoveryLease>((resolve) => {
      grantLease = resolve;
    });
    const acquireStoreRecoveryLease = vi.fn(() => pendingLease);
    const assertOwned = vi.fn();
    const release = vi.fn();
    const db = fakeDatabase();
    const openPreparedStore = vi.fn((adoption: GenerationAdoptionLockLease) => {
      adoption.assertOwned();
      return db;
    });

    const coordinating = coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: {
        kind: 'operator',
        validateSelectedTarget: () => {
          throw new Error('validator should not run');
        },
        classifyStore: () => ({ kind: 'fresh' }),
        acquireStoreRecoveryLease,
        openPreparedStore,
      },
    });
    await vi.waitFor(() => expect(acquireStoreRecoveryLease).toHaveBeenCalledOnce());
    expect(openPreparedStore).not.toHaveBeenCalled();

    grantLease({ assertOwned, release });
    await expect(coordinating).resolves.toEqual({ kind: 'opened', db });
    expect(assertOwned).toHaveBeenCalledOnce();
    expect(openPreparedStore).toHaveBeenCalledOnce();
    expect(assertOwned.mock.invocationCallOrder[0]).toBeLessThan(openPreparedStore.mock.invocationCallOrder[0]);
    expect(release).toHaveBeenCalledOnce();
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
        },
      }),
    ).rejects.toThrow('requires a real filesystem store path');

    expect(mkdirSync).not.toHaveBeenCalled();
  });
});
