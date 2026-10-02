import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { readBuildFlavor, readBundleHash } from '#src/infra/bundle-manifest.js';

const tempRoots: string[] = [];

function createPluginRoot(name: string, bundleHash?: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  if (bundleHash !== undefined) {
    writeFileSync(join(root, 'bridge', 'manifest.json'), JSON.stringify({ bundleHash }, null, 2), 'utf-8');
  }
  return root;
}

afterEach(() => {
  delete (globalThis as { __BUNDLE_DIR__?: string }).__BUNDLE_DIR__;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('infra namespace isolation', () => {
  it('isolates bundle hash cache entries by plugin root', () => {
    const rootA = createPluginRoot('coral-bundle-a', 'bundle-a');
    const rootB = createPluginRoot('coral-bundle-b', 'bundle-b');

    expect(readBundleHash(rootA)).toBe('bundle-a');
    expect(readBundleHash(rootB)).toBe('bundle-b');
  });

  it('reads build flavor from manifest and fails open to prod', () => {
    const devRoot = createPluginRoot('coral-flavor-dev');
    const prodRoot = createPluginRoot('coral-flavor-prod');
    const missingRoot = createPluginRoot('coral-flavor-missing');
    const corruptRoot = createPluginRoot('coral-flavor-corrupt');

    writeFileSync(
      join(devRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'bundle-dev', flavor: 'dev' }),
      'utf-8',
    );
    writeFileSync(
      join(prodRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'bundle-prod', flavor: 'prod' }),
      'utf-8',
    );
    writeFileSync(join(corruptRoot, 'bridge', 'manifest.json'), '{not-json', 'utf-8');

    expect(readBuildFlavor(devRoot)).toBe('dev');
    expect(readBuildFlavor(prodRoot)).toBe('prod');
    expect(readBuildFlavor(missingRoot)).toBe('prod');
    expect(readBuildFlavor(corruptRoot)).toBe('prod');
  });

  it('prefers the manifest colocated with the active bundle when bundled', () => {
    const root = createPluginRoot('coral-bundle-root', 'bridge-bundle');
    const bundleDir = mkdtempSync(join(tmpdir(), 'coral-bundle-dir-'));
    tempRoots.push(bundleDir);
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({ bundleHash: 'active-bundle', flavor: 'dev' }),
      'utf-8',
    );

    (globalThis as { __BUNDLE_DIR__?: string }).__BUNDLE_DIR__ = bundleDir;

    expect(readBundleHash(root)).toBe('active-bundle');
    expect(readBuildFlavor(root)).toBe('dev');
  });

  it('pluginRootNamespace resolves symlinks before hashing (symlink and target share namespace)', () => {
    const target = createPluginRoot('coral-symlink-target');
    const link = join(tmpdir(), `coral-symlink-link-${Date.now()}`);
    tempRoots.push(link);
    symlinkSync(target, link);

    expect(pluginRootNamespace(link)).toBe(pluginRootNamespace(target));
  });
});
