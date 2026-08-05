import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator, type ForeignTargetValidator } from '#src/infra/handoff-target.js';
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
import { createBackendStoreResetAuthority } from '#src/store/backend-store-reset.js';
import type { Database } from '#src/store/db.js';
import {
  parseStoreResetIncidentManifest,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_QUARANTINE_DIRECTORY,
} from '#src/store/reset-incident.js';
import { routeOrOpenBackendStoreAtStartup } from '#src/store/startup-store-routing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const backendBundle = 'selection recovery backend';
const cliBundle = 'selection recovery cli';
const claudeAppserverBundle = 'selection recovery claude appserver';

function manifest(version: string, buildSetId: string): StrictBundleManifest {
  return {
    version,
    buildSetId,
    bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
    cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
    claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
    flavor: 'prod',
    storeFormatFingerprint: storeFormat.fingerprint,
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

function createBundle(parent: string, expected: StrictBundleManifest): string {
  const bundleDir = join(parent, `bundle-${expected.version}-${expected.buildSetId.slice(0, 8)}`);
  mkdirSync(bundleDir, { mode: 0o700 });
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle);
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle);
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle);
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(expected));
  return bundleDir;
}

function harness(): {
  root: string;
  runtime: Runtime;
  currentSelection: ActiveStoreSelection;
  authority: ReturnType<typeof createBackendStoreResetAuthority>;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-active-selection-recovery-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const currentManifest = manifest(storeFormat.productVersion, '123e4567-e89b-42d3-a456-426614174000');
  const currentSelection = selection(currentManifest, createBundle(root, currentManifest));
  const authority = createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: false },
    {
      namespace: 'active-selection-recovery-test',
      storeFormat,
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
  return { exec: vi.fn(), close: vi.fn() } as unknown as Database;
}

function compatibleClassification() {
  return {
    kind: 'compatible' as const,
    currentFingerprint: storeFormat.fingerprint,
    currentProductVersion: storeFormat.productVersion,
    storedFingerprint: storeFormat.fingerprint,
    storedProductVersion: storeFormat.productVersion,
  };
}

function createNewerStore(runtime: Runtime): void {
  const path = runtime.paths.coral.store.dbFile;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insert.run('store_format_fingerprint', storeFormat.fingerprint);
    insert.run('store_product_version', '99.0.0');
  } finally {
    db.close();
  }
}

function tableExists(path: string, table: string): boolean {
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
  if (incident === undefined) throw new Error('Expected a store-reset incident.');
  return parseStoreResetIncidentManifest(readFileSync(join(quarantine, incident, STORE_RESET_MANIFEST_FILE_NAME)));
}

function supersededTransitionEvidencePath(recordAudit: ReturnType<typeof vi.fn>, failureCode: string): string {
  const call = recordAudit.mock.calls.find(([event]) => event === 'active-store-transition-superseded');
  expect(call?.[1]).toMatchObject({ failureCode });
  const evidencePath = (call?.[1] as { readonly evidencePath?: unknown } | undefined)?.evidencePath;
  if (typeof evidencePath !== 'string') throw new Error('Expected superseded transition evidence path.');
  return evidencePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('active-store selection recovery', () => {
  it('should return the shared handoff arm for a valid newer selection without touching the store', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selected = selection(selectedManifest, createBundle(root, selectedManifest));
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));
    const classifyStore = vi.fn();
    const openStore = vi.fn();

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
        dependencies: { classifyStore, openStore },
      },
    });

    expect(result.kind).toBe('handoff');
    expect(classifyStore).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: selected });
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
  });

  it('should supersede an interrupted transition from an older build and preserve its bytes', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const olderManifest = manifest('0.0.0-rc.1', '223e4567-e89b-42d3-a456-426614174000');
    const olderSelection = selection(olderManifest, createBundle(root, olderManifest));
    const staleTransition: ActiveStoreTransition = {
      version: 1,
      transitionId: '323e4567-e89b-42d3-a456-426614174000',
      kind: 'selection-recovery',
      evidence: { kind: 'selection-absent', storeEvidence: { kind: 'pending-classification' } },
      currentManifest: olderManifest,
      currentBundleDir: olderSelection.bundleDir,
    };
    const staleBytes = encodeActiveStoreTransition(staleTransition);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(olderSelection));
    publish(runtime, 'transitionFile', staleBytes);
    const db = fakeDatabase();
    const recordAudit = vi.fn();

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
        dependencies: {
          classifyStore: compatibleClassification,
          openStore: () => db,
          recordAudit,
        },
      },
    });

    expect(result).toEqual({ kind: 'open', db });
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(readFileSync(supersededTransitionEvidencePath(recordAudit, 'transition_current_build_mismatch'))).toEqual(
      Buffer.from(staleBytes),
    );
  });

  it('should supersede a newer-build transition before handing off from an older build', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const newerManifest = manifest('99.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const newerSelection = selection(newerManifest, createBundle(root, newerManifest));
    const staleTransition: ActiveStoreTransition = {
      version: 1,
      transitionId: '423e4567-e89b-42d3-a456-426614174000',
      kind: 'selection-recovery',
      evidence: { kind: 'selection-absent', storeEvidence: { kind: 'pending-classification' } },
      currentManifest: newerManifest,
      currentBundleDir: newerSelection.bundleDir,
    };
    const staleBytes = encodeActiveStoreTransition(staleTransition);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(newerSelection));
    publish(runtime, 'transitionFile', staleBytes);
    const classifyStore = vi.fn();
    const openStore = vi.fn();
    const recordAudit = vi.fn();

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
        dependencies: { classifyStore, openStore, recordAudit },
      },
    });

    expect(result.kind).toBe('handoff');
    expect(classifyStore).not.toHaveBeenCalled();
    expect(openStore).not.toHaveBeenCalled();
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(readFileSync(supersededTransitionEvidencePath(recordAudit, 'transition_current_build_mismatch'))).toEqual(
      Buffer.from(staleBytes),
    );
  });

  it('should supersede a malformed transition instead of refusing startup', async () => {
    const { runtime, currentSelection, authority } = harness();
    const malformedBytes = new TextEncoder().encode('{}');
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', malformedBytes);
    const db = fakeDatabase();
    const recordAudit = vi.fn();

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: {
        storeFormat,
        currentSelection,
        dependencies: {
          classifyStore: compatibleClassification,
          openStore: () => db,
          recordAudit,
        },
      },
    });

    expect(result).toEqual({ kind: 'open', db });
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(readFileSync(supersededTransitionEvidencePath(recordAudit, 'transition_invalid_schema'))).toEqual(
      Buffer.from(malformedBytes),
    );
  });

  it.each(['pruned artifact', 'tampered artifact'] as const)(
    'should recover a %s from a readable store without reset',
    async (failure) => {
      const { root, runtime, currentSelection, authority } = harness();
      const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
      const selectedBundleDir = createBundle(root, selectedManifest);
      const selected = selection(selectedManifest, selectedBundleDir);
      publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));
      if (failure === 'pruned artifact') {
        unlinkSync(join(selectedBundleDir, 'coral-cli.cjs'));
      } else {
        writeFileSync(join(selectedBundleDir, 'coral-backend.cjs'), 'tampered backend');
      }
      const db = fakeDatabase();
      const recordAudit = vi.fn();

      const result = await routeOrOpenBackendStoreAtStartup({
        runtime,
        authority,
        validateForeignTarget: createForeignTargetValidator(),
        options: {
          storeFormat,
          currentSelection,
          dependencies: {
            classifyStore: compatibleClassification,
            openStore: () => db,
            recordAudit,
          },
        },
      });

      expect(result).toMatchObject({
        kind: 'reset-newer-invalid',
        evidence: { failure: 'adjacent-bundle-mismatch' },
        db,
      });
      expect(recordAudit).toHaveBeenCalledWith(
        'invalid-selection-recovery',
        expect.objectContaining({ evidenceKind: 'valid-target-invalid' }),
        'warn',
      );
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: currentSelection });
      expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    },
  );

  it('should retain the selected manifest when the selected bundle directory was pruned', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selectedBundleDir = createBundle(root, selectedManifest);
    const selected = selection(selectedManifest, selectedBundleDir);
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(selected));
    rmSync(selectedBundleDir, { recursive: true, force: true });
    createNewerStore(runtime);
    const recordAudit = vi.fn();

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: { storeFormat, currentSelection, dependencies: { recordAudit } },
    });

    expect(result).toMatchObject({
      kind: 'reset-newer-invalid',
      evidence: { failure: 'bundle-dir-unavailable' },
    });
    if (result.kind === 'reset-newer-invalid') result.db.close();
    expect(recordAudit).toHaveBeenCalledWith(
      'invalid-selection-recovery',
      expect.objectContaining({ evidenceKind: 'valid-target-invalid', failureCode: 'bundle-dir-unavailable' }),
      'warn',
    );
    expect(newestIncidentManifest(runtime)).toMatchObject({
      schemaVersion: 3,
      resetPolicyCause: 'newer-incompatible-invalid-target',
      resetPolicyEvidence: {
        validationFailure: { code: 'bundle-dir-unavailable' },
        observedTarget: {
          version: selectedManifest.version,
          buildSetId: selectedManifest.buildSetId,
          bundleHash: selectedManifest.bundleHash,
          flavor: selectedManifest.flavor,
          storeFormatFingerprint: selectedManifest.storeFormatFingerprint,
        },
      },
    });
  });

  it('should audit a malformed selection and open a readable store', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', new TextEncoder().encode('{malformed'));
    const db = fakeDatabase();
    const recordAudit = vi.fn();
    const validateForeignTarget: ForeignTargetValidator = vi.fn(() => {
      throw new Error('validator should not run');
    });

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget,
      options: {
        storeFormat,
        currentSelection,
        dependencies: {
          classifyStore: compatibleClassification,
          openStore: () => db,
          recordAudit,
        },
      },
    });

    expect(result).toEqual({ kind: 'open', db });
    expect(validateForeignTarget).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      'invalid-selection-recovery',
      expect.objectContaining({ evidenceKind: 'selection-malformed' }),
      'warn',
    );
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });

  it('should wrap an unreadable store classification in the documented protocol error', async () => {
    const { runtime, currentSelection, authority } = harness();
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    const failure = Object.assign(new Error('EACCES: permission denied while opening store.db'), { code: 'EACCES' });

    await expect(
      routeOrOpenBackendStoreAtStartup({
        runtime,
        authority,
        validateForeignTarget: createForeignTargetValidator(),
        options: {
          storeFormat,
          currentSelection,
          dependencies: {
            classifyStore: () => {
              throw failure;
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'store_corrupt_or_unsupported',
      context: {
        path: runtime.paths.coral.store.dbFile,
        flavor: runtime.flavor,
        cause: failure.message,
      },
    });
  });

  it.each([
    ['absent', 'selection-absent'],
    ['exact', 'current-selection-newer-store'],
  ] as const)('should recover a newer store for an %s selection', async (selectionState, failureCode) => {
    const { runtime, currentSelection, authority } = harness();
    if (selectionState === 'exact') {
      publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    }
    createNewerStore(runtime);

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget: createForeignTargetValidator(),
      options: { storeFormat, currentSelection },
    });

    expect(result.kind).toBe('open');
    if (result.kind !== 'open') return;
    result.db.close();
    expect(tableExists(runtime.paths.coral.store.dbFile, 'sentinel_before_reset')).toBe(false);
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
    expect(newestIncidentManifest(runtime)).toMatchObject({
      schemaVersion: 3,
      resetPolicyCause: 'newer-incompatible-invalid-target',
      resetPolicyEvidence: { validationFailure: { code: failureCode } },
    });
  });

  it('should resume an invalid-target transition before treating the current selection as exact', async () => {
    const { root, runtime, currentSelection, authority } = harness();
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const priorSelection = selection(selectedManifest, createBundle(root, selectedManifest));
    unlinkSync(join(priorSelection.bundleDir, 'coral-cli.cjs'));
    const transition: ActiveStoreTransition = {
      version: 1,
      transitionId: '323e4567-e89b-42d3-a456-426614174000',
      kind: 'selection-recovery',
      evidence: {
        kind: 'valid-target-invalid',
        priorSelection,
        invalidTargetEvidence: {
          bundleDir: priorSelection.bundleDir,
          expectedManifest: priorSelection.manifest,
          failure: 'adjacent-bundle-mismatch',
        },
        storeEvidence: { kind: 'pending-classification' },
      },
      currentManifest: currentSelection.manifest,
      currentBundleDir: currentSelection.bundleDir,
    };
    publish(runtime, 'selectionFile', encodeActiveStoreSelection(currentSelection));
    publish(runtime, 'transitionFile', encodeActiveStoreTransition(transition));
    const db = fakeDatabase();
    const recordAudit = vi.fn();
    const validateForeignTarget: ForeignTargetValidator = vi.fn(() => {
      throw new Error('validator should not run');
    });

    const result = await routeOrOpenBackendStoreAtStartup({
      runtime,
      authority,
      validateForeignTarget,
      options: {
        storeFormat,
        currentSelection,
        dependencies: {
          classifyStore: compatibleClassification,
          openStore: () => db,
          recordAudit,
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'reset-newer-invalid',
      evidence: { failure: 'adjacent-bundle-mismatch' },
      db,
    });
    expect(validateForeignTarget).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledOnce();
    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'absent' });
  });
});
