import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backendInfoPath, backendLockPath, pluginRootNamespace } from '../paths.js';
import { readBundleHash } from '../../shared/mcp-utils.js';

const tempRoots: string[] = [];

function createPluginRoot(name: string, bundleHash?: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  if (bundleHash !== undefined) {
    writeFileSync(
      join(root, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash }, null, 2),
      'utf-8',
    );
  }
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('client namespace isolation', () => {
  it('isolates backend discovery files by plugin root', () => {
    const rootA = createPluginRoot('coral-plugin-a');
    const rootB = createPluginRoot('coral-plugin-b');

    expect(backendInfoPath(rootA)).not.toBe(backendInfoPath(rootB));
    expect(backendLockPath(rootA)).not.toBe(backendLockPath(rootB));
  });

  it('isolates bundle hash cache entries by plugin root', () => {
    const rootA = createPluginRoot('coral-bundle-a', 'bundle-a');
    const rootB = createPluginRoot('coral-bundle-b', 'bundle-b');

    expect(readBundleHash(rootA)).toBe('bundle-a');
    expect(readBundleHash(rootB)).toBe('bundle-b');
  });

  it('matches the AC25 namespace hashing algorithm', () => {
    const pluginRoot = createPluginRoot('coral-namespace');
    const testPath = realpathSync(pluginRoot);

    expect(pluginRootNamespace(pluginRoot)).toBe(
      createHash('sha256').update(testPath).digest('hex').slice(0, 12),
    );
  });
});
