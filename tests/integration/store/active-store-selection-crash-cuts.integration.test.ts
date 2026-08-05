import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';
import type { ForeignTargetValidator } from '#src/infra/handoff-target.js';
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
  type ActiveStoreSelectionOperatorDependencies,
  type ActiveStoreSelectionProtocolDependencies,
  type ActiveStoreSelectionStartupDependencies,
} from '#src/store/active-store-selection-coordination.js';
import { createBackendStoreResetAuthority, type BackendStoreResetAuthority } from '#src/store/backend-store-reset.js';
import type { Database } from '#src/store/db.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import {
  parseStoreResetIncidentManifest,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_QUARANTINE_DIRECTORY,
} from '#src/store/reset-incident.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

type EvidenceArm = 'absent' | 'malformed' | 'invalid-target';
type PublicationRecord = 'transitionFile' | 'selectionFile';
type PublicationCut = 'temporary-write' | 'rename' | 'directory-fsync';

const roots: string[] = [];
const evidenceArms = ['absent', 'malformed', 'invalid-target'] as const;
const publicationRecords = ['transitionFile', 'selectionFile'] as const;
const publicationCuts = ['temporary-write', 'rename', 'directory-fsync'] as const;

function manifest(version: string, buildSetId: string, fill: string): StrictBundleManifest {
  return {
    version,
    buildSetId,
    bundleHash: fill.repeat(16),
    cliBundleHash: fill.repeat(16),
    claudeAppserverBundleHash: fill.repeat(16),
    flavor: 'prod',
    storeFormatFingerprint: currentCoralStoreFormat().fingerprint,
  };
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
  readonly runtime: Runtime;
  readonly currentSelection: ActiveStoreSelection;
  readonly authority: BackendStoreResetAuthority;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-selection-crash-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const currentManifest = manifest(
    currentCoralStoreFormat().productVersion,
    '123e4567-e89b-42d3-a456-426614174000',
    'a',
  );
  const bundleDir = join(root, 'current-bundle');
  mkdirSync(bundleDir, { mode: 0o700 });
  const currentSelection = selection(currentManifest, bundleDir);
  const authority = createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: false },
    {
      namespace: 'selection-crash-test',
      storeFormat: currentCoralStoreFormat(),
      build: currentManifest,
    },
  );
  return { runtime, currentSelection, authority };
}

function publish(runtime: Runtime, record: PublicationRecord, bytes: Uint8Array): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.coordinationRoot, 0o700);
  expect(runtime.storage.writeAtomicDurableSync(paths[record], bytes, { mode: 0o600 })).toBe(true);
}

function invalidTargetValidator(): ForeignTargetValidator {
  return (bundleDir, expectedManifest) => ({
    kind: 'invalid',
    evidence: {
      bundleDir,
      expectedManifest,
      failure: 'adjacent-manifest-unavailable',
    },
  });
}

function prepareEvidence(
  arm: EvidenceArm,
  runtime: Runtime,
  currentSelection: ActiveStoreSelection,
): Partial<Omit<ActiveStoreSelectionOperatorDependencies, 'kind'>> {
  if (arm === 'malformed') {
    publish(runtime, 'selectionFile', new TextEncoder().encode('{malformed'));
    return {};
  }
  if (arm === 'invalid-target') {
    const root = dirname(currentSelection.bundleDir);
    const selectedManifest = manifest('99.0.0', '223e4567-e89b-42d3-a456-426614174000', 'b');
    const selectedBundleDir = join(root, 'selected-bundle');
    mkdirSync(selectedBundleDir, { mode: 0o700 });
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(selection(selectedManifest, selectedBundleDir)));
    return { validateSelectedTarget: invalidTargetValidator() };
  }
  return {};
}

function fakeDatabase(): Database {
  return { exec: vi.fn(), close: vi.fn() } as unknown as Database;
}

function successfulDependencies(
  extra: Partial<Omit<ActiveStoreSelectionOperatorDependencies, 'kind'>> = {},
): ActiveStoreSelectionOperatorDependencies {
  return {
    kind: 'operator',
    validateSelectedTarget: () => {
      throw new Error('validator should not run');
    },
    classifyStore: () => ({ kind: 'fresh' }),
    openStore: () => fakeDatabase(),
    ...extra,
  };
}

function startupDependencies(): ActiveStoreSelectionStartupDependencies {
  return {
    kind: 'startup',
    validateSelectedTarget: () => {
      throw new Error('validator should not run');
    },
  };
}

function installPublicationCut(runtime: Runtime, record: PublicationRecord, cut: PublicationCut): () => void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const target = paths[record];
  const original = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
  runtime.storage.writeAtomicDurableSync = (path, bytes, options) => {
    if (path !== target) return original(path, bytes, options);
    if (cut === 'temporary-write') {
      throw new Error(`crash:${record}:temporary-write`);
    }
    if (cut === 'rename') {
      writeFileSync(`${path}.crash-tmp`, bytes, { mode: options?.mode ?? 0o600 });
      throw new Error(`crash:${record}:rename`);
    }
    original(path, bytes, options);
    return false;
  };
  return () => {
    runtime.storage.writeAtomicDurableSync = original;
  };
}

function pendingTransition(
  currentSelection: ActiveStoreSelection,
  evidence: ActiveStoreTransition['evidence'],
): ActiveStoreTransition {
  return {
    version: 1,
    transitionId: '323e4567-e89b-42d3-a456-426614174000',
    kind: 'selection-recovery',
    evidence,
    currentManifest: currentSelection.manifest,
    currentBundleDir: currentSelection.bundleDir,
  };
}

function createVersionedStore(runtime: Runtime, productVersion: string): void {
  const path = runtime.paths.coral.store.dbFile;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
    db.prepare("INSERT INTO meta (key, value) VALUES ('store_format_fingerprint', ?)").run(
      currentCoralStoreFormat().fingerprint,
    );
    db.prepare("INSERT INTO meta (key, value) VALUES ('store_product_version', ?)").run(productVersion);
  } finally {
    db.close();
  }
}

function tableExists(path: string, table: string): boolean {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  } finally {
    db.close();
  }
}

function newestIncidentManifest(runtime: Runtime) {
  const quarantine = join(runtime.paths.coral.store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
  const incident = readdirSync(quarantine)
    .filter((entry) => entry !== '.staging')
    .sort()
    .at(-1);
  if (incident === undefined) throw new Error('Expected a reset incident.');
  return parseStoreResetIncidentManifest(readFileSync(join(quarantine, incident, STORE_RESET_MANIFEST_FILE_NAME)));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('active-store-selection crash cuts', () => {
  it.each(
    evidenceArms.flatMap((arm) =>
      publicationRecords.flatMap((record) => publicationCuts.map((cut) => [arm, record, cut] as const)),
    ),
  )('should leave the store untouched for %s at %s %s', async (arm, record, cut) => {
    const { runtime, currentSelection, authority } = harness();
    const evidenceDependencies = prepareEvidence(arm, runtime, currentSelection);
    const classifyStore = vi.fn(() => ({ kind: 'fresh' as const }));
    const openStore = vi.fn(() => fakeDatabase());
    const restore = installPublicationCut(runtime, record, cut);

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: successfulDependencies({ ...evidenceDependencies, classifyStore, openStore }),
      }),
    ).rejects.toThrow();
    restore();

    expect(classifyStore).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
    expect(existsSync(resolveGenerationBoundaryPaths(runtime).adoptionLock)).toBe(false);
    if (record === 'selectionFile') {
      expect(readActiveStoreTransition(runtime).kind).toBe('valid');
    }
  });

  it.each(evidenceArms)(
    'should resume %s intent after current selection publication and reset-lock failure',
    async (arm) => {
      const { runtime, currentSelection, authority } = harness();
      const evidenceDependencies = prepareEvidence(arm, runtime, currentSelection);
      const resetLock = join(runtime.paths.coral.store.dbDir, 'store.db.reset.lock');
      mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true });
      const releaseReset = acquireDirectoryLockSync(resetLock, 1_000);
      try {
        await expect(
          coordinateActiveStoreSelection(runtime, authority, {
            storeFormat: currentCoralStoreFormat(),
            currentSelection,
            dependencies: successfulDependencies(evidenceDependencies),
          }),
        ).rejects.toMatchObject({ code: 'store_reset_lock_contended' });
      } finally {
        releaseReset();
      }

      expect(readActiveStoreTransition(runtime).kind).toBe('valid');
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
      const resumed = await coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: successfulDependencies(),
      });
      expect(resumed.kind).toBe('opened');
      expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    },
  );

  it('should serialize a concurrent coordinator behind the adoption lock', async () => {
    const { runtime, currentSelection, authority } = harness();
    const boundary = resolveGenerationBoundaryPaths(runtime);
    mkdirSync(boundary.generationRoot, { recursive: true });
    const releaseAdoption = acquireDirectoryLockSync(boundary.adoptionLock, 1_000);
    const classifyStore = vi.fn(() => ({ kind: 'fresh' as const }));
    const openStore = vi.fn(() => fakeDatabase());
    const originalSleep = runtime.time.sleep.bind(runtime.time);
    let observeContention: () => void = () => undefined;
    const contentionObserved = new Promise<void>((resolve) => {
      observeContention = resolve;
    });
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async (ms) => {
      observeContention();
      await originalSleep(ms);
    });

    const coordinating = coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: successfulDependencies({ classifyStore, openStore }),
    });
    await contentionObserved;
    try {
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'absent' });
      expect(classifyStore).not.toHaveBeenCalled();
      expect(openStore).not.toHaveBeenCalled();
    } finally {
      releaseAdoption();
    }

    const result = await coordinating;
    expect(result.kind).toBe('opened');
    expect(classifyStore).toHaveBeenCalledOnce();
    expect(openStore).toHaveBeenCalledOnce();
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
    expect(existsSync(boundary.adoptionLock)).toBe(false);
  });

  it('should reclassify an exact current selection when it crashes before newer-store intent publication', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    const paths = resolveActiveStoreRecordPaths(runtime);
    const original = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
    runtime.storage.writeAtomicDurableSync = (path, bytes, options) => {
      if (path === paths.transitionFile) throw new Error('crash:pre-intent-publication');
      return original(path, bytes, options);
    };
    const classifyStore = vi.fn(() => ({
      kind: 'newer-incompatible' as const,
      currentFingerprint: currentCoralStoreFormat().fingerprint,
      currentProductVersion: currentSelection.manifest.version,
      storedFingerprint: currentCoralStoreFormat().fingerprint,
      storedProductVersion: '99.0.0',
    }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        coordinateActiveStoreSelection(runtime, authority, {
          storeFormat: currentCoralStoreFormat(),
          currentSelection,
          dependencies: successfulDependencies({ classifyStore, openStore: vi.fn() }),
        }),
      ).rejects.toThrow('crash:pre-intent-publication');
      expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    }
    expect(classifyStore).toHaveBeenCalledTimes(2);
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
  });

  it('should preserve pending intent when newer-store evidence advance fails', async () => {
    const { runtime, currentSelection, authority } = harness();
    const transition = pendingTransition(currentSelection, {
      kind: 'selection-absent',
      storeEvidence: { kind: 'pending-classification' },
    });
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(transition));
    const restore = installPublicationCut(runtime, 'transitionFile', 'rename');

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: successfulDependencies({
          classifyStore: () => ({
            kind: 'newer-incompatible',
            currentFingerprint: currentCoralStoreFormat().fingerprint,
            currentProductVersion: currentSelection.manifest.version,
            storedFingerprint: currentCoralStoreFormat().fingerprint,
            storedProductVersion: '99.0.0',
          }),
          openStore: vi.fn(),
        }),
      }),
    ).rejects.toThrow('crash:transitionFile:rename');
    restore();

    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'valid', transition });
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
  });

  it('should publish V3 newer-store evidence, reset, initialize, open, and clear intent', async () => {
    const { runtime, currentSelection, authority } = harness();
    createVersionedStore(runtime, '99.0.0');

    const result = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: startupDependencies(),
    });
    expect(result.kind).toBe('opened');
    if (result.kind === 'opened') result.db.close();

    expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(false);
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(newestIncidentManifest(runtime)).toMatchObject({
      schemaVersion: 3,
      resetPolicyCause: 'newer-incompatible-invalid-target',
      resetPolicyEvidence: { validationFailure: { code: 'selection-absent' } },
    });
    expect(existsSync(resolveGenerationBoundaryPaths(runtime).adoptionLock)).toBe(false);
  });

  it('should resume after incident publication fails without resetting the store', async () => {
    const { runtime, currentSelection, authority } = harness();
    createVersionedStore(runtime, '99.0.0');
    const original = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
    runtime.storage.writeAtomicDurableSync = (path, bytes, options) =>
      basename(path) === STORE_RESET_MANIFEST_FILE_NAME ? false : original(path, bytes, options);

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: startupDependencies(),
      }),
    ).rejects.toMatchObject({ code: 'store_reset_quarantine_failed' });
    expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(true);
    expect(readActiveStoreTransition(runtime)).toMatchObject({
      kind: 'valid',
      transition: { evidence: { storeEvidence: { kind: 'newer-incompatible' } } },
    });

    runtime.storage.writeAtomicDurableSync = original;
    const resumed = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: startupDependencies(),
    });
    if (resumed.kind === 'opened') resumed.db.close();
    expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(false);
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });

  it('should resume after reset starts but before active evidence is removed', async () => {
    const { runtime, currentSelection, authority } = harness();
    createVersionedStore(runtime, '99.0.0');
    const originalUnlink = runtime.storage.unlinkSync.bind(runtime.storage);
    let cut = true;
    runtime.storage.unlinkSync = (path) => {
      if (cut && path === runtime.paths.coral.store.dbFile) {
        cut = false;
        throw new Error('crash:reset');
      }
      originalUnlink(path);
    };

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: startupDependencies(),
      }),
    ).rejects.toMatchObject({ code: 'store_reset_quarantine_failed' });
    expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(true);

    runtime.storage.unlinkSync = originalUnlink;
    const resumed = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: startupDependencies(),
    });
    if (resumed.kind === 'opened') resumed.db.close();
    expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(false);
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });

  it('should resume after initialization/open fails and after open succeeds before transition clear', async () => {
    for (const cut of ['open', 'transition-clear'] as const) {
      const { runtime, currentSelection, authority } = harness();
      createVersionedStore(runtime, '99.0.0');
      const originalUnlink = runtime.storage.unlinkSync.bind(runtime.storage);
      const dependencies: ActiveStoreSelectionProtocolDependencies =
        cut === 'open'
          ? successfulDependencies({
              openStore: () => {
                throw new Error('crash:open');
              },
            })
          : startupDependencies();
      if (cut === 'transition-clear') {
        runtime.storage.unlinkSync = (path) => {
          if (path === resolveActiveStoreRecordPaths(runtime).transitionFile) {
            throw new Error('crash:transition-clear');
          }
          originalUnlink(path);
        };
      }

      await expect(
        coordinateActiveStoreSelection(runtime, authority, {
          storeFormat: currentCoralStoreFormat(),
          currentSelection,
          dependencies,
        }),
      ).rejects.toThrow(`crash:${cut}`);
      expect(readActiveStoreTransition(runtime).kind).toBe('valid');

      runtime.storage.unlinkSync = originalUnlink;
      const resumed = await coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies: startupDependencies(),
      });
      if (resumed.kind === 'opened') resumed.db.close();
      expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
      expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(false);
    }
  });

  it('should retain durable invalid-selection evidence when the audit log is unavailable', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', new TextEncoder().encode('{malformed'));
    const db = fakeDatabase();
    const dependencies = successfulDependencies({
      openStore: () => db,
      recordAudit: () => {
        throw new Error('crash:audit');
      },
    });

    await expect(
      coordinateActiveStoreSelection(runtime, authority, {
        storeFormat: currentCoralStoreFormat(),
        currentSelection,
        dependencies,
      }),
    ).rejects.toThrow('crash:audit');
    expect(db.close).toHaveBeenCalledOnce();
    expect(readActiveStoreTransition(runtime).kind).toBe('valid');
    const retainedRoot = join(
      runtime.paths.coral.store.dbDir,
      STORE_RESET_QUARANTINE_DIRECTORY,
      'retained-active-store-transitions',
    );
    const retainedEntries = readdirSync(retainedRoot);
    expect(retainedEntries).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(retainedRoot, retainedEntries[0]), 'utf8'))).toEqual(
      expect.objectContaining({ evidence: expect.objectContaining({ kind: 'selection-malformed' }) }),
    );

    const unavailableAudit = vi.fn();
    const resumed = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: successfulDependencies({ recordAudit: unavailableAudit }),
    });
    expect(resumed.kind).toBe('opened');
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(unavailableAudit).toHaveBeenCalledWith('invalid-selection-recovery', expect.anything(), 'warn');
    expect(readdirSync(retainedRoot)).toEqual(retainedEntries);
  });

  it('should replay the durable store outcome after a crash before adoption-lock release', async () => {
    const { runtime, currentSelection, authority } = harness();
    const boundary = resolveGenerationBoundaryPaths(runtime);
    const originalUnlink = runtime.storage.unlinkSync.bind(runtime.storage);
    let releaseCut = true;
    runtime.storage.unlinkSync = (path) => {
      if (releaseCut && dirname(path) === boundary.adoptionLock) {
        releaseCut = false;
        throw new Error('crash:adoption-lock-release');
      }
      originalUnlink(path);
    };

    const opened = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: startupDependencies(),
    });
    if (opened.kind === 'opened') opened.db.close();
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(existsSync(boundary.adoptionLock)).toBe(true);

    runtime.storage.unlinkSync = originalUnlink;
    rmSync(boundary.adoptionLock, { recursive: true, force: true });
    const replayed = await coordinateActiveStoreSelection(runtime, authority, {
      storeFormat: currentCoralStoreFormat(),
      currentSelection,
      dependencies: startupDependencies(),
    });
    if (replayed.kind === 'opened') replayed.db.close();
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(true);
  });
});
