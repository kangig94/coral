import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('matches the namespace hashing algorithm', () => {
    const pluginRoot = createPluginRoot('coral-namespace');
    const testPath = realpathSync(pluginRoot);

    expect(pluginRootNamespace(pluginRoot)).toBe(createHash('sha256').update(testPath).digest('hex').slice(0, 12));
  });

  // ── pluginRootNamespace edge cases (from algorithm-parity) ────────────────

  it('pluginRootNamespace resolves symlinks before hashing (symlink and target share namespace)', () => {
    const target = createPluginRoot('coral-symlink-target');
    const link = join(tmpdir(), `coral-symlink-link-${Date.now()}`);
    tempRoots.push(link);
    symlinkSync(target, link);

    expect(pluginRootNamespace(link)).toBe(pluginRootNamespace(target));
  });

  it('pluginRootNamespace throws when path does not exist (no silent fallback to raw path)', () => {
    const nonExistent = join(tmpdir(), 'coral-does-not-exist-' + Date.now());
    expect(() => pluginRootNamespace(nonExistent)).toThrow();
  });

  it('pluginRootNamespace output is always 12 hex chars', () => {
    const root = createPluginRoot('coral-hex-check');
    const result = pluginRootNamespace(root);
    expect(result).toHaveLength(12);
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  it('algorithm does not use base64 encoding of the digest', () => {
    const root = createPluginRoot('coral-no-base64');
    const path = realpathSync(root);
    const wrongBase64 = createHash('sha256').update(path).digest('base64').slice(0, 12);
    expect(pluginRootNamespace(root)).not.toBe(wrongBase64);
  });

  it('algorithm does not slice raw bytes (binary slice would differ from hex slice)', () => {
    const root = createPluginRoot('coral-no-raw-bytes');
    const path = realpathSync(root);
    const wrongBytesHex = createHash('sha256').update(path).digest().slice(0, 12).toString('hex');
    expect(pluginRootNamespace(root)).toHaveLength(12);
    expect(pluginRootNamespace(root)).not.toBe(wrongBytesHex);
  });
});
