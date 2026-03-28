import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { backendInfoPath, backendLockPath, installationDir, pluginRootNamespace } from '../../infra/paths.js';
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

  it('matches the namespace hashing algorithm', () => {
    const pluginRoot = createPluginRoot('coral-namespace');
    const testPath = realpathSync(pluginRoot);

    expect(pluginRootNamespace(pluginRoot)).toBe(
      createHash('sha256').update(testPath).digest('hex').slice(0, 12),
    );
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

  // ── installationDir path structure ────────────────────────────────────────

  it('installationDir returns path under ~/.claude/coral/installations/', () => {
    const root = createPluginRoot('coral-instdir');
    const result = installationDir(root);
    const expectedBase = join(homedir(), '.claude', 'coral', 'installations');
    expect(result.startsWith(expectedBase)).toBe(true);
  });

  it('installationDir path ends with the 12-char namespace hash', () => {
    const root = createPluginRoot('coral-instdir-hash');
    const ns = pluginRootNamespace(root);
    const instDir = installationDir(root);
    expect(instDir.endsWith(ns)).toBe(true);
  });

  it('installationDir is different for different plugin roots', () => {
    const rootA = createPluginRoot('coral-instdir-a');
    const rootB = createPluginRoot('coral-instdir-b');
    expect(installationDir(rootA)).not.toBe(installationDir(rootB));
  });

  // ── backendInfoPath / backendLockPath structure ───────────────────────────

  it('backendInfoPath result is under the namespaced installation directory', () => {
    const root = createPluginRoot('coral-info-under-inst');
    const infoPath = backendInfoPath(root);
    const instDir = installationDir(root);
    expect(infoPath.startsWith(instDir)).toBe(true);
  });

  it('backendInfoPath is NOT under the legacy ~/.claude/coral/backend.json location', () => {
    const root = createPluginRoot('coral-info-not-legacy');
    const infoPath = backendInfoPath(root);
    const legacyPath = join(homedir(), '.claude', 'coral', 'backend.json');
    expect(infoPath).not.toBe(legacyPath);
  });

  it('backendInfoPath ends with backend.json', () => {
    const root = createPluginRoot('coral-info-suffix');
    expect(backendInfoPath(root)).toMatch(/backend\.json$/);
  });

  it('backendLockPath ends with backend.lock', () => {
    const root = createPluginRoot('coral-lock-suffix');
    expect(backendLockPath(root)).toMatch(/backend\.lock$/);
  });

  it('backendLockPath and backendInfoPath share the same parent directory', () => {
    const root = createPluginRoot('coral-shared-parent');
    const infoPath = backendInfoPath(root);
    const lockPath = backendLockPath(root);
    const infoParent = join(infoPath, '..');
    const lockParent = join(lockPath, '..');
    expect(lockParent).toBe(infoParent);
  });
});
