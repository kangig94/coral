import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveStrictBundleIdentity,
  type EmbeddedBundleIdentity,
  type StrictBundleManifest,
} from '#src/infra/bundle-manifest.js';

const roots: string[] = [];
const embedded: EmbeddedBundleIdentity = {
  version: '0.9.16',
  buildSetId: '123e4567-e89b-12d3-a456-426614174000',
  flavor: 'prod',
};
const manifest: StrictBundleManifest = {
  ...embedded,
  bundleHash: '0123456789abcdef',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};

function bundleDir(contents: unknown = manifest): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-strict-bundle-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(contents)}\n`, 'utf-8');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('strict bundle identity', () => {
  it('accepts only an adjacent manifest matching the embedded build identity', () => {
    expect(resolveStrictBundleIdentity({ bundleDir: bundleDir(), embedded })).toEqual({
      ok: true,
      manifest,
    });
  });

  it.each([
    ['version', { ...manifest, version: '0.9.15' }],
    ['build set', { ...manifest, buildSetId: '223e4567-e89b-12d3-a456-426614174000' }],
    ['flavor', { ...manifest, flavor: 'dev' }],
  ])('rejects a stale %s pairing', (_name, stale) => {
    expect(resolveStrictBundleIdentity({ bundleDir: bundleDir(stale), embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_mismatch',
    });
  });

  it('rejects a missing adjacent manifest without searching another directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-strict-bundle-missing-'));
    roots.push(root);
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_unavailable',
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['invalid version', JSON.stringify({ ...manifest, version: 'latest' })],
    ['invalid build-set ID', JSON.stringify({ ...manifest, buildSetId: 'not-a-uuid' })],
    ['invalid bundle hash', JSON.stringify({ ...manifest, bundleHash: 'bundle' })],
    ['invalid fingerprint', JSON.stringify({ ...manifest, storeFormatFingerprint: 'old' })],
  ])('rejects %s', (_name, contents) => {
    const root = bundleDir();
    writeFileSync(join(root, 'manifest.json'), contents, 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_invalid',
    });
  });

  it('bounds the adjacent manifest before parsing', () => {
    const root = bundleDir();
    writeFileSync(join(root, 'manifest.json'), 'x'.repeat(16 * 1024 + 1), 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_unavailable',
    });
  });
});
