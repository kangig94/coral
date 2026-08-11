import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator, type ForeignTargetValidator } from '#src/infra/handoff-target.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  publishActiveStoreSelection,
  readActiveStoreSelection,
  type ActiveStoreSelection,
} from '#src/store/active-store-selection.js';
import { createBackendStoreResetAuthority } from '#src/store/backend-store-reset.js';
import {
  parseStoreResetIncidentManifest,
  STORE_RESET_MANIFEST_FILE_NAME,
  STORE_RESET_QUARANTINE_DIRECTORY,
} from '#src/store/reset-incident.js';
import { routeOrOpenBackendStoreAtStartup } from '#src/store/startup-store-routing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const roots: string[] = [];
const backendBundle = 'startup routing backend';
const cliBundle = 'startup routing cli';
const claudeAppserverBundle = 'startup routing claude appserver';
const storeFormat = currentCoralStoreFormat();

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

function selection(manifestValue: StrictBundleManifest, bundleDir: string): ActiveStoreSelection {
  return {
    version: 1,
    manifest: manifestValue,
    bundleDir,
    activeStoreFingerprint: manifestValue.storeFormatFingerprint,
  };
}

function createBundle(root: string, manifestValue: StrictBundleManifest): string {
  const bundleDir = mkdtempSync(join(root, 'bundle-'));
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle);
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle);
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle);
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifestValue));
  return bundleDir;
}

function harness(version = '2.0.0'): {
  readonly runtime: Runtime;
  readonly current: ActiveStoreSelection;
  readonly authority: ReturnType<typeof createBackendStoreResetAuthority>;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-startup-store-routing-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const currentManifest = manifest(version, '123e4567-e89b-42d3-a456-426614174000');
  const current = selection(currentManifest, createBundle(root, currentManifest));
  const authority = createBackendStoreResetAuthority(
    runtime,
    { acquiredViaHandoff: false },
    {
      namespace: 'startup-routing-test',
      storeFormat: { ...storeFormat, productVersion: version },
      build: currentManifest,
    },
  );
  return { runtime, current, authority };
}

function validatorThatMustNotRun(): ForeignTargetValidator {
  return vi.fn(() => {
    throw new Error('validator should not run');
  });
}

async function route(
  runtime: Runtime,
  authority: ReturnType<typeof createBackendStoreResetAuthority>,
  current: ActiveStoreSelection,
  validateForeignTarget: ForeignTargetValidator,
) {
  return routeOrOpenBackendStoreAtStartup({
    runtime,
    authority,
    validateForeignTarget,
    options: {
      storeFormat: { ...storeFormat, productVersion: current.manifest.version },
      currentSelection: current,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('startup-store-routing', () => {
  it.each([
    ['exact', '2.0.0', '123e4567-e89b-42d3-a456-426614174000'],
    ['older', '1.0.0', '223e4567-e89b-42d3-a456-426614174000'],
    ['equal version', '2.0.0+selected', '223e4567-e89b-42d3-a456-426614174000'],
  ])(
    'should open with the current build for an %s selection without target validation',
    async (relation, version, buildSetId) => {
      const { runtime, current, authority } = harness();
      const selectedManifest = manifest(version, buildSetId);
      const selected =
        relation === 'exact'
          ? current
          : selection(selectedManifest, createBundle(dirname(current.bundleDir), selectedManifest));
      publishActiveStoreSelection(runtime, selected);
      const validator = validatorThatMustNotRun();

      const routing = await route(runtime, authority, current, validator);

      expect(routing.kind).toBe('open');
      if (routing.kind === 'open') routing.db.close();
      expect(validator).not.toHaveBeenCalled();
      expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: current });
    },
  );

  it('should hand off to a validated newer selection without touching the store', async () => {
    const { runtime, current, authority } = harness('1.0.0');
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selected = selection(selectedManifest, createBundle(dirname(current.bundleDir), selectedManifest));
    publishActiveStoreSelection(runtime, selected);

    const routing = await route(runtime, authority, current, createForeignTargetValidator());

    expect(routing.kind).toBe('handoff');
    expect(existsSync(runtime.paths.coral.store.dbFile)).toBe(false);
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: selected });
  });

  it('should recover an invalid newer target through the locked evidence protocol', async () => {
    const { runtime, current, authority } = harness('1.0.0');
    const selected = selection(
      manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'),
      join(dirname(current.bundleDir), 'missing-selected-bundle'),
    );
    publishActiveStoreSelection(runtime, selected);

    const routing = await route(runtime, authority, current, createForeignTargetValidator());

    expect(routing).toMatchObject({
      kind: 'reset-newer-invalid',
      evidence: { failure: 'bundle-dir-unavailable' },
    });
    if (routing.kind === 'reset-newer-invalid') routing.db.close();
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: current });
    expect(
      existsSync(
        join(runtime.paths.coral.store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY, 'retained-active-store-transitions'),
      ),
    ).toBe(true);
  });

  it('should classify exact-selection store bytes and durably reset a newer store', async () => {
    const { runtime, current, authority } = harness('1.0.0');
    publishActiveStoreSelection(runtime, current);
    const dbPath = runtime.paths.coral.store.dbFile;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sentinel_before_reset (id INTEGER PRIMARY KEY);
      INSERT INTO sentinel_before_reset (id) VALUES (1);
    `);
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insert.run('store_format_fingerprint', storeFormat.fingerprint);
    insert.run('store_product_version', '2.0.0');
    db.close();

    const routing = await route(runtime, authority, current, validatorThatMustNotRun());

    expect(routing.kind).toBe('open');
    if (routing.kind === 'open') routing.db.close();
    const opened = new DatabaseSync(dbPath);
    expect(
      opened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sentinel_before_reset'").get(),
    ).toBeUndefined();
    opened.close();
    const quarantine = join(runtime.paths.coral.store.dbDir, STORE_RESET_QUARANTINE_DIRECTORY);
    const incident = runtime.storage
      .readDirectoryBoundedSync(quarantine, 16)
      .entries.find((entry) => entry !== '.staging');
    if (incident === undefined) throw new Error('Expected a retained reset incident.');
    expect(
      parseStoreResetIncidentManifest(readFileSync(join(quarantine, incident, STORE_RESET_MANIFEST_FILE_NAME))),
    ).toMatchObject({
      schemaVersion: 3,
      resetPolicyCause: 'newer-incompatible-invalid-target',
    });
  });
});
