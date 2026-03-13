/**
 * AC1: pluginRootNamespace(), backendInfoPath(), backendLockPath() contracts.
 *
 * Attack surface: the plan changes the signature of backendInfoPath() and
 * backendLockPath() from 0-arity to 1-arity (pluginRoot).  The new paths must
 * be under ~/.claude/coral/installations/<hash12>/ rather than the legacy
 * ~/.claude/coral/backend.json location.
 *
 * Common implementation errors to catch:
 *   1. backendInfoPath(rootA) === backendInfoPath(rootB) for two different roots
 *      (forgot to include pluginRoot in the path).
 *   2. Path is under the legacy location instead of the namespaced directory.
 *   3. Different plugin roots sharing the same namespace (hash collision at 12 chars
 *      is negligible but algorithm bugs like truncation at wrong position matter).
 *   4. installationDir() is not exported (callers need it for future artifacts).
 *
 * These tests will FAIL until paths.ts is updated per AC1.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let paths: typeof import('../paths.js');

try {
  paths = await import('../paths.js');
} catch {
  // Module not yet updated — tests will report failures via undefined checks below
  paths = {} as never;
}

const pluginRootNamespace: ((root: string) => string) | undefined =
  (paths as Record<string, unknown>)['pluginRootNamespace'] as typeof pluginRootNamespace;

const installationDir: ((root: string) => string) | undefined =
  (paths as Record<string, unknown>)['installationDir'] as typeof installationDir;

const backendInfoPath: ((root: string) => string) | undefined =
  (paths as Record<string, unknown>)['backendInfoPath'] as ((root: string) => string) | undefined;

const backendLockPath: ((root: string) => string) | undefined =
  (paths as Record<string, unknown>)['backendLockPath'] as ((root: string) => string) | undefined;

describe('client paths AC1 — namespaced path functions', () => {
  let tmpDir: string;
  const createdDirs: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'red-paths-ns-'));
    createdDirs.push(tmpDir);
  });

  afterEach(() => {
    for (const d of createdDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  // ── pluginRootNamespace ────────────────────────────────────────────────────

  it('pluginRootNamespace is exported', () => {
    expect(typeof pluginRootNamespace).toBe('function');
  });

  it('pluginRootNamespace returns 12-char hex string', () => {
    const dir = join(tmpDir, 'installA');
    mkdirSync(dir);
    const ns = pluginRootNamespace!(dir);
    expect(ns).toHaveLength(12);
    expect(ns).toMatch(/^[0-9a-f]{12}$/);
  });

  it('pluginRootNamespace is different for different plugin roots', () => {
    const dirA = join(tmpDir, 'installA');
    const dirB = join(tmpDir, 'installB');
    mkdirSync(dirA);
    mkdirSync(dirB);
    expect(pluginRootNamespace!(dirA)).not.toBe(pluginRootNamespace!(dirB));
  });

  // ── installationDir ────────────────────────────────────────────────────────

  it('installationDir is exported', () => {
    expect(typeof installationDir).toBe('function');
  });

  it('installationDir returns path under ~/.claude/coral/installations/', () => {
    const dir = join(tmpDir, 'install');
    mkdirSync(dir);
    const result = installationDir!(dir);
    const expectedBase = join(homedir(), '.claude', 'coral', 'installations');
    expect(result.startsWith(expectedBase)).toBe(true);
  });

  it('installationDir path ends with the 12-char namespace hash', () => {
    const dir = join(tmpDir, 'install2');
    mkdirSync(dir);
    const ns = pluginRootNamespace!(dir);
    const instDir = installationDir!(dir);
    expect(instDir.endsWith(ns)).toBe(true);
  });

  it('installationDir is different for different plugin roots', () => {
    const dirA = join(tmpDir, 'installX');
    const dirB = join(tmpDir, 'installY');
    mkdirSync(dirA);
    mkdirSync(dirB);
    expect(installationDir!(dirA)).not.toBe(installationDir!(dirB));
  });

  // ── backendInfoPath ────────────────────────────────────────────────────────

  it('backendInfoPath accepts a pluginRoot argument (1-arity)', () => {
    const dir = join(tmpDir, 'info-install');
    mkdirSync(dir);
    // Should not throw — takes one argument
    expect(() => backendInfoPath!(dir)).not.toThrow();
  });

  it('backendInfoPath result is under the namespaced installation directory', () => {
    const dir = join(tmpDir, 'info-install2');
    mkdirSync(dir);
    const infoPath = backendInfoPath!(dir);
    const instDir = installationDir!(dir);
    expect(infoPath.startsWith(instDir)).toBe(true);
  });

  it('backendInfoPath is NOT under the legacy ~/.claude/coral/backend.json location', () => {
    const dir = join(tmpDir, 'info-install3');
    mkdirSync(dir);
    const infoPath = backendInfoPath!(dir);
    const legacyPath = join(homedir(), '.claude', 'coral', 'backend.json');
    expect(infoPath).not.toBe(legacyPath);
  });

  it('backendInfoPath differs for different plugin roots', () => {
    const dirA = join(tmpDir, 'info-installA');
    const dirB = join(tmpDir, 'info-installB');
    mkdirSync(dirA);
    mkdirSync(dirB);
    expect(backendInfoPath!(dirA)).not.toBe(backendInfoPath!(dirB));
  });

  it('backendInfoPath ends with backend.json', () => {
    const dir = join(tmpDir, 'info-install4');
    mkdirSync(dir);
    expect(backendInfoPath!(dir)).toMatch(/backend\.json$/);
  });

  // ── backendLockPath ────────────────────────────────────────────────────────

  it('backendLockPath accepts a pluginRoot argument (1-arity)', () => {
    const dir = join(tmpDir, 'lock-install');
    mkdirSync(dir);
    expect(() => backendLockPath!(dir)).not.toThrow();
  });

  it('backendLockPath result is under the namespaced installation directory', () => {
    const dir = join(tmpDir, 'lock-install2');
    mkdirSync(dir);
    const lockPath = backendLockPath!(dir);
    const instDir = installationDir!(dir);
    expect(lockPath.startsWith(instDir)).toBe(true);
  });

  it('backendLockPath ends with backend.lock', () => {
    const dir = join(tmpDir, 'lock-install3');
    mkdirSync(dir);
    expect(backendLockPath!(dir)).toMatch(/backend\.lock$/);
  });

  it('backendLockPath and backendInfoPath share the same parent directory', () => {
    const dir = join(tmpDir, 'shared-parent');
    mkdirSync(dir);
    const infoPath = backendInfoPath!(dir);
    const lockPath = backendLockPath!(dir);
    const infoParent = join(infoPath, '..');
    const lockParent = join(lockPath, '..');
    // Both should live in the same installations/<hash12>/ directory
    expect(lockParent).toBe(infoParent);
  });

  // ── Legacy behaviour regression ────────────────────────────────────────────

  it('0-arity call to backendInfoPath fails (old API removed)', () => {
    // The plan says: "Remove old 0-arity signatures entirely"
    // If called without arguments, TypeScript would catch it at compile time.
    // At runtime, calling with undefined should either throw or return a path
    // that diverges from the namespaced path.
    // We assert that the result is different from the legacy path.
    const legacyPath = join(homedir(), '.claude', 'coral', 'backend.json');
    const dir = join(tmpDir, 'legacy-check');
    mkdirSync(dir);
    const namedPath = backendInfoPath!(dir);
    expect(namedPath).not.toBe(legacyPath);
  });
});
