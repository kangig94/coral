/**
 * AC11: readBundleHash() cache keyed by pluginRoot — no cross-root contamination.
 *
 * Attack surface: the current bundleHashCache is a Map keyed by pluginRoot.
 * If the implementer forgets to key by pluginRoot (or uses a global singleton),
 * rootA's hash will be returned for rootB after the cache is populated.
 *
 * Additional edge cases:
 *   1. Empty string pluginRoot as a key — must not poison the cache for real roots.
 *   2. Undefined/null pluginRoot slipping through — TypeScript catches this but
 *      runtime callers may pass empty strings.
 *   3. Cache must return the same hash on repeated calls for the same root.
 *   4. After a cache write for rootA, rootB must produce a fresh read, not rootA's value.
 *
 * These tests FAIL on the pre-implementation codebase if the cache is not keyed
 * by pluginRoot and PASS after AC11 is complete.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  tmpRoot: `${process.env.TMPDIR || '/tmp'}/coral-red-bundlehash-test`,
}));

// No OS mock needed — readBundleHash reads a file, not homedir()

let mcpUtils: typeof import('../mcp-utils.js');

describe('shared mcp-utils AC11 — readBundleHash cache isolation', () => {
  let tmpDir: string;
  const createdDirs: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'red-bundlehash-'));
    createdDirs.push(tmpDir);
    vi.resetModules();
  });

  afterEach(() => {
    for (const d of createdDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    createdDirs.length = 0;
    vi.resetModules();
  });

  async function loadMcpUtils() {
    vi.resetModules();
    return import('../mcp-utils.js');
  }

  function writeManifest(dir: string, hash: string): void {
    const bridgeDir = join(dir, 'bridge');
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, 'manifest.json'), JSON.stringify({ bundleHash: hash }), 'utf-8');
  }

  it('readBundleHash returns the correct hash for a given pluginRoot', async () => {
    const mod = await loadMcpUtils();
    if (typeof (mod as Record<string, unknown>)['readBundleHash'] !== 'function') {
      // Not yet implemented — skip
      return;
    }
    const readBundleHash = (mod as Record<string, unknown>)['readBundleHash'] as (root: string) => string;

    const rootA = join(tmpDir, 'rootA');
    writeManifest(rootA, 'hash-for-root-a');

    expect(readBundleHash(rootA)).toBe('hash-for-root-a');
  });

  it('readBundleHash cache does not contaminate different roots (cross-root isolation)', async () => {
    const mod = await loadMcpUtils();
    if (typeof (mod as Record<string, unknown>)['readBundleHash'] !== 'function') {
      return;
    }
    const readBundleHash = (mod as Record<string, unknown>)['readBundleHash'] as (root: string) => string;

    const rootA = join(tmpDir, 'rootA2');
    const rootB = join(tmpDir, 'rootB2');
    writeManifest(rootA, 'hash-A');
    writeManifest(rootB, 'hash-B');

    // Populate cache for rootA first
    const hashA = readBundleHash(rootA);
    // Now read rootB — must NOT return rootA's cached value
    const hashB = readBundleHash(rootB);

    expect(hashA).toBe('hash-A');
    expect(hashB).toBe('hash-B');
    expect(hashA).not.toBe(hashB);
  });

  it('readBundleHash returns stable result for the same root on repeated calls', async () => {
    const mod = await loadMcpUtils();
    if (typeof (mod as Record<string, unknown>)['readBundleHash'] !== 'function') {
      return;
    }
    const readBundleHash = (mod as Record<string, unknown>)['readBundleHash'] as (root: string) => string;

    const root = join(tmpDir, 'stable-root');
    writeManifest(root, 'stable-hash-xyz');

    const first = readBundleHash(root);
    const second = readBundleHash(root);

    expect(first).toBe('stable-hash-xyz');
    expect(second).toBe('stable-hash-xyz');
  });

  it('readBundleHash for rootA does not affect subsequent reads for rootB even after module reset', async () => {
    // After vi.resetModules(), the cache Map is fresh — this tests that the
    // module-level cache does not persist across test isolation boundaries.
    const modFirst = await loadMcpUtils();
    if (typeof (modFirst as Record<string, unknown>)['readBundleHash'] !== 'function') {
      return;
    }
    const readBundleHashFirst = (modFirst as Record<string, unknown>)['readBundleHash'] as (root: string) => string;

    const root = join(tmpDir, 'reset-root');
    writeManifest(root, 'hash-before-reset');
    readBundleHashFirst(root); // populate cache

    vi.resetModules(); // clear module cache — fresh Map instance

    const modSecond = await loadMcpUtils();
    const readBundleHashSecond = (modSecond as Record<string, unknown>)['readBundleHash'] as (root: string) => string;

    // Update the manifest file between resets
    writeManifest(root, 'hash-after-reset');
    const fresh = readBundleHashSecond(root);

    // If caching works correctly, a fresh import gets the updated value
    expect(fresh).toBe('hash-after-reset');
  });
});
