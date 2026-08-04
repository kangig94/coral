import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import {
  createForeignTargetValidator,
  withValidatedHandoffTarget,
  type ForeignTargetValidator,
  type InvalidTargetEvidence,
} from '#src/infra/handoff-target.js';
import type { ActiveStoreSelection } from '#src/store/active-store-selection.js';
import { classifyStoreFile } from '#src/store/db.js';
import { routeActiveStoreSelection } from '#src/store/startup-store-routing.js';

const roots: string[] = [];
const backendBundle = 'startup routing backend';
const cliBundle = 'startup routing cli';
const claudeAppserverBundle = 'startup routing claude appserver';
const storeFormatFingerprint = `sha256:${'a'.repeat(64)}` as const;

function manifest(version: string, buildSetId: string): StrictBundleManifest {
  return {
    version,
    buildSetId,
    bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
    cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
    claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
    flavor: 'prod',
    storeFormatFingerprint,
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

function createBundle(manifestValue: StrictBundleManifest): string {
  const bundleDir = mkdtempSync(join(tmpdir(), 'coral-startup-store-routing-bundle-'));
  roots.push(bundleDir);
  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifestValue), 'utf8');
  return bundleDir;
}

function createStore(productVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-startup-store-routing-db-'));
  roots.push(root);
  const dbPath = join(root, 'store.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value);
      CREATE TABLE sentinel (id INTEGER PRIMARY KEY);
    `);
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insert.run('store_format_fingerprint', storeFormatFingerprint);
    insert.run('store_product_version', productVersion);
  } finally {
    db.close();
  }
  return dbPath;
}

function validatorThatMustNotRun(): ForeignTargetValidator {
  return vi.fn(() => {
    throw new Error('validator should not run');
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
  ])('should use the current build for an %s selection without target validation', (relation, version, buildSetId) => {
    const current = selection(manifest('2.0.0', '123e4567-e89b-42d3-a456-426614174000'), '/current');
    const selected = selection(manifest(version, buildSetId), relation === 'exact' ? current.bundleDir : '/selected');

    expect(
      routeActiveStoreSelection({
        selected,
        current,
        validateForeignTarget: validatorThatMustNotRun(),
      }),
    ).toEqual({ kind: 'use-current', evidence: { source: 'current-build' } });
  });

  it('should hand off to a validated newer selection', () => {
    const current = selection(manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000'), '/current');
    const selectedManifest = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    const selected = selection(selectedManifest, createBundle(selectedManifest));

    const routing = routeActiveStoreSelection({
      selected,
      current,
      validateForeignTarget: createForeignTargetValidator(),
    });

    expect(routing.kind).toBe('handoff');
    if (routing.kind !== 'handoff') return;
    expect(routing.source).toBe('active-selection');
    withValidatedHandoffTarget(routing.target).assertExecutable();
  });

  it('should return the sole reset arm when a newer selection target is invalid', () => {
    const current = selection(manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000'), '/current');
    const selected = selection(manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000'), '/missing-selected-bundle');
    const evidence: InvalidTargetEvidence = {
      bundleDir: selected.bundleDir,
      expectedManifest: selected.manifest,
      failure: 'adjacent-manifest-unavailable',
    };

    expect(
      routeActiveStoreSelection({
        selected,
        current,
        validateForeignTarget: () => ({ kind: 'invalid', evidence }),
      }),
    ).toEqual({ kind: 'reset-newer-invalid', evidence });
  });

  it('should classify opened bytes independently after the selection chooses the current route', () => {
    const current = selection(manifest('1.0.0', '123e4567-e89b-42d3-a456-426614174000'), '/current');
    const routing = routeActiveStoreSelection({
      selected: current,
      current,
      validateForeignTarget: validatorThatMustNotRun(),
    });
    const dbPath = createStore('1.1.0');

    expect(routing).toEqual({ kind: 'use-current', evidence: { source: 'current-build' } });
    expect(
      classifyStoreFile(
        dbPath,
        { existsSync },
        {
          fingerprint: current.manifest.storeFormatFingerprint,
          productVersion: current.manifest.version,
        },
      ),
    ).toEqual({
      kind: 'newer-incompatible',
      currentFingerprint: storeFormatFingerprint,
      currentProductVersion: '1.0.0',
      storedFingerprint: storeFormatFingerprint,
      storedProductVersion: '1.1.0',
    });
  });
});
