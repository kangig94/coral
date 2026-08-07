import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveRunningBundleDir,
  resolveStrictBundleIdentity,
  type EmbeddedBundleIdentity,
  type StrictBundleManifest,
} from '#src/infra/bundle-manifest.js';

const roots: string[] = [];
const embedded: EmbeddedBundleIdentity = {
  version: '0.9.16',
  buildSetId: '123e4567-e89b-12d3-a456-426614174000',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};
const backendBundle = 'strict backend fixture';
const cliBundle = 'strict cli fixture';
const claudeAppserverBundle = 'strict claude appserver fixture';
const manifest: StrictBundleManifest = {
  ...embedded,
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
};

function bundleDir(contents: unknown = manifest): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-strict-bundle-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'coral-backend.cjs'), backendBundle, 'utf-8');
  writeFileSync(join(root, 'coral-cli.cjs'), cliBundle, 'utf-8');
  writeFileSync(join(root, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf-8');
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(contents)}\n`, 'utf-8');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundle-manifest', () => {
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
    ['store format', { ...manifest, storeFormatFingerprint: `sha256:${'b'.repeat(64)}` }],
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

  it('rejects an adjacent backend whose content does not match the manifest', () => {
    const root = bundleDir();
    writeFileSync(join(root, 'coral-backend.cjs'), 'tampered backend', 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_mismatch',
    });
  });

  it.each([
    ['coral-cli.cjs', 'tampered cli'],
    ['coral-claude-appserver.cjs', 'tampered claude appserver'],
  ])('rejects a mismatched adjacent %s artifact', (file, contents) => {
    const root = bundleDir();
    writeFileSync(join(root, file), contents, 'utf-8');
    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_mismatch',
    });
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['invalid version', JSON.stringify({ ...manifest, version: 'latest' })],
    ['invalid build-set ID', JSON.stringify({ ...manifest, buildSetId: 'not-a-uuid' })],
    ['invalid bundle hash', JSON.stringify({ ...manifest, bundleHash: 'bundle' })],
    ['invalid fingerprint', JSON.stringify({ ...manifest, storeFormatFingerprint: 'old' })],
    ['unknown manifest field', JSON.stringify({ ...manifest, extra: true })],
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

  it('rejects a symlinked adjacent manifest', () => {
    const root = bundleDir();
    const target = join(root, 'manifest-target.json');
    writeFileSync(target, `${JSON.stringify(manifest)}\n`, 'utf-8');
    rmSync(join(root, 'manifest.json'));
    symlinkSync(target, join(root, 'manifest.json'));

    expect(resolveStrictBundleIdentity({ bundleDir: root, embedded })).toEqual({
      ok: false,
      reason: 'adjacent_manifest_unavailable',
    });
  });

  it('resolves the running bridge directory to a canonical path', () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-running-bundle-'));
    roots.push(pluginRoot);
    const bridge = join(pluginRoot, 'bridge');
    mkdirSync(bridge);

    expect(resolveRunningBundleDir(pluginRoot)).toBe(realpathSync(bridge));
  });
});
