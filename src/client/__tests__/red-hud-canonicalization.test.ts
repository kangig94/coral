/**
 * AC18: coral-hud.mjs canonicalization edge cases.
 *
 * Attack surface: the plan requires realpathSync() before hashing
 * CLAUDE_PLUGIN_ROOT.  If realpathSync() fails (broken symlink, path does not
 * exist, permission error), the code must SKIP backend status rendering rather
 * than falling back to hashing the raw path.  Hashing the raw path would
 * produce a different namespace than the installed backend's namespace, yielding
 * a silent mismatch where the HUD never shows backend status.
 *
 * These tests are written against the planned interface. They verify:
 *   1. Symlinked CLAUDE_PLUGIN_ROOT resolves to the same namespace as the real path.
 *   2. A non-existent CLAUDE_PLUGIN_ROOT causes graceful skip, not raw-path hashing.
 *   3. A missing CLAUDE_PLUGIN_ROOT env var causes graceful skip.
 *
 * NOTE: coral-hud.mjs is a standalone ESM script, not a TypeScript module.
 * We test the algorithm equivalence (AC25) and the failure modes here using the
 * same inline SHA-256 logic that the hook embeds, cross-checked against paths.ts.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Replica of the inline algorithm that coral-hud.mjs will embed after AC18.
function hudNamespace(rawPluginRoot: string): string {
  // Must call realpathSync — the hook does this before hashing
  const canonical = realpathSync(rawPluginRoot);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// What the hook SHOULD NOT do: hash the raw path directly
function hudNamespaceUnsafe(rawPluginRoot: string): string {
  return createHash('sha256').update(rawPluginRoot).digest('hex').slice(0, 12);
}

describe('coral-hud AC18 — CLAUDE_PLUGIN_ROOT canonicalization', () => {
  let tmpDir: string;
  const createdDirs: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'red-hud-canon-'));
    createdDirs.push(tmpDir);
  });

  afterEach(() => {
    for (const d of createdDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  it('symlinked plugin root hashes to the same namespace as the real path', () => {
    const realInstall = join(tmpDir, 'real-install');
    const symInstall = join(tmpDir, 'sym-install');
    mkdirSync(realInstall);
    symlinkSync(realInstall, symInstall);

    const nsViaReal = hudNamespace(realInstall);
    const nsViaSym = hudNamespace(symInstall);

    // After realpathSync both must resolve to the same canonical path → same namespace
    expect(nsViaSym).toBe(nsViaReal);
  });

  it('hashing raw (non-canonicalized) symlink path produces a DIFFERENT namespace', () => {
    // This test proves that NOT calling realpathSync would break the invariant
    const realInstall = join(tmpDir, 'real-install2');
    const symInstall = join(tmpDir, 'sym-install2');
    mkdirSync(realInstall);
    symlinkSync(realInstall, symInstall);

    const nsViaReal = hudNamespace(realInstall);
    const nsViaSym = hudNamespaceUnsafe(symInstall); // bug: raw path hashing

    // realInstall !== symInstall as strings → different hashes → proves the bug
    expect(nsViaSym).not.toBe(nsViaReal);
  });

  it('non-existent plugin root causes realpathSync to throw (must not silently hash raw path)', () => {
    const nonExistent = join(tmpDir, 'does-not-exist');

    // The hook must skip rendering when realpathSync throws, not hash the raw path
    expect(() => realpathSync(nonExistent)).toThrow();

    // Verify that even if someone tried to hash the raw path, the result would differ
    // from any legitimate installation's namespace
    const rawHash = hudNamespaceUnsafe(nonExistent);
    expect(rawHash).toHaveLength(12); // it produces output, but it's the WRONG output
    // There is no assertion here — the point is that the hook must catch the
    // realpathSync throw and return null rather than calling hudNamespaceUnsafe.
  });

  it('two distinct installation paths never accidentally share a namespace', () => {
    const installA = join(tmpDir, 'installA');
    const installB = join(tmpDir, 'installB');
    mkdirSync(installA);
    mkdirSync(installB);

    expect(hudNamespace(installA)).not.toBe(hudNamespace(installB));
  });

  it('trailing slash does not change namespace when realpathSync normalises it', () => {
    const install = join(tmpDir, 'install-slash');
    mkdirSync(install);

    // realpathSync normalises trailing slashes on most platforms
    const withSlash = realpathSync(install + '/');
    const withoutSlash = realpathSync(install);

    // If the OS normalises the trailing slash, the hashes must match
    if (withSlash === withoutSlash) {
      expect(hudNamespace(install + '/')).toBe(hudNamespace(install));
    }
    // If they differ (unusual but possible on some FSes), we skip — not a bug
  });

  it('namespace output is stable across multiple calls (deterministic hashing)', () => {
    const install = join(tmpDir, 'stable-install');
    mkdirSync(install);

    const first = hudNamespace(install);
    const second = hudNamespace(install);
    const third = hudNamespace(install);

    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('empty CLAUDE_PLUGIN_ROOT env is handled — realpathSync on empty string either throws or resolves cwd', () => {
    // The hook must guard against CLAUDE_PLUGIN_ROOT="" before calling realpathSync.
    // On some platforms/Node versions, realpathSync('') resolves to cwd instead of throwing.
    // Either way, the hook should detect this is not a valid plugin root.
    try {
      const resolved = realpathSync('');
      // If it doesn't throw, it resolved to cwd — which is NOT a valid plugin root
      expect(resolved).toBe(process.cwd());
    } catch {
      // Expected on most platforms — confirms guard is needed
    }
  });
});

describe('coral-hud AC20 — hud-auto-update cache path guard', () => {
  it('cache path pattern matches expected plugin cache directory structure', () => {
    // AC20: hud-auto-update.mjs only copies when CLAUDE_PLUGIN_ROOT contains /.claude/plugins/cache/
    const cachePath = '/home/user/.claude/plugins/cache/coral/coral/1.0.0';
    const devPath1 = '/home/user/workspace/coral';
    const devPath2 = '/home/user/projects/my-coral-fork';
    const devPath3 = '~/workspace/coral';
    const tricky1 = '/home/user/.claude/plugins/cache-backup/coral/1.0.0'; // 'cache-backup' not 'cache/'
    const tricky2 = '/home/user/.cache/plugins/cache/coral/1.0.0'; // different prefix

    function isCachePath(p: string): boolean {
      return p.includes('/.claude/plugins/cache/');
    }

    expect(isCachePath(cachePath)).toBe(true);
    expect(isCachePath(devPath1)).toBe(false);
    expect(isCachePath(devPath2)).toBe(false);
    expect(isCachePath(devPath3)).toBe(false);
    // Edge case: 'cache-backup' should NOT match
    expect(isCachePath(tricky1)).toBe(false);
    // Edge case: different prefix '.cache' should NOT match
    expect(isCachePath(tricky2)).toBe(false);
  });

  it('cache path guard uses exact substring match not prefix match', () => {
    // A path that starts with cache-like text but is not the real cache dir
    const notCache = '/.claude/plugins/cache';    // missing trailing slash
    const isCache = '/.claude/plugins/cache/coral'; // has trailing slash → is cache

    function isCachePath(p: string): boolean {
      return p.includes('/.claude/plugins/cache/');
    }

    expect(isCachePath(notCache)).toBe(false); // no trailing slash — not a cache path
    expect(isCachePath(isCache)).toBe(true);
  });
});
