/**
 * AC1/AC25: Algorithm parity between pluginRootNamespace() in paths.ts
 * and the inline SHA-256 algorithm used in coral-hud.mjs / backend-warm-start.mjs.
 *
 * Attack surface: the hook files are standalone ESM and cannot import from the bundle,
 * so any algorithm drift (wrong encoding, slice length, digest format) produces
 * silently wrong namespaces. The implementer may copy the algorithm once and forget
 * to keep it in sync. These tests prove the expected contract so drift gets caught.
 *
 * NOTE: These tests are written against the PLANNED interface described in AC1.
 * They will fail until pluginRootNamespace() is implemented in src/client/paths.ts.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Inline replica of the algorithm that coral-hud.mjs and backend-warm-start.mjs
// are expected to embed after the refactor.  This is the spec; any divergence
// in the hook files constitutes a bug.
// ---------------------------------------------------------------------------
function inlineNamespace(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Import the planned paths.ts export under test
// ---------------------------------------------------------------------------
// NOTE: This import will throw until pluginRootNamespace is added to paths.ts.
// That is intentional – the test suite exists to prove the implementation gap.
let pluginRootNamespace: (pluginRoot: string) => string;

try {
  // Dynamic import so the test file itself can be parsed even when the export
  // is absent.  Individual tests that rely on the export will still fail.
  const mod = await import('../paths.js');
  pluginRootNamespace = (mod as unknown as { pluginRootNamespace: typeof pluginRootNamespace }).pluginRootNamespace;
} catch {
  // Stub so tests that only test the inline algorithm still run.
  pluginRootNamespace = () => { throw new Error('pluginRootNamespace not yet implemented'); };
}

describe('client paths pluginRootNamespace algorithm parity', () => {
  let tmpDir: string;
  const createdDirs: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'red-ns-parity-'));
    createdDirs.push(tmpDir);
  });

  afterEach(() => {
    for (const d of createdDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  // ── Inline algorithm contract ──────────────────────────────────────────────

  it('inline algorithm produces exactly 12 hex characters', () => {
    const result = inlineNamespace('/home/user/.claude/plugins/cache/coral/coral/1.0.0');
    expect(result).toHaveLength(12);
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  it('inline algorithm is deterministic for the same input', () => {
    const path = '/home/user/.claude/plugins/cache/coral/coral/1.0.0';
    expect(inlineNamespace(path)).toBe(inlineNamespace(path));
  });

  it('inline algorithm produces different outputs for different paths', () => {
    const a = inlineNamespace('/home/user/.claude/plugins/cache/coral/coral/1.0.0');
    const b = inlineNamespace('/home/user/.claude/plugins/cache/coral/coral/2.0.0');
    expect(a).not.toBe(b);
  });

  it('inline algorithm is case-sensitive', () => {
    const lower = inlineNamespace('/home/User/project');
    const upper = inlineNamespace('/home/user/project');
    expect(lower).not.toBe(upper);
  });

  it('inline algorithm uses UTF-8 encoding (not latin1 or base64)', () => {
    // Verify the hash matches what Node's crypto produces with default UTF-8
    const path = '/tmp/coral-test-path';
    const expected = createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 12);
    expect(inlineNamespace(path)).toBe(expected);
  });

  it('inline algorithm slices exactly 0:12 of hex digest (not bytes)', () => {
    // A hex digest is 64 chars; 12 chars = first 6 bytes of the hash
    const path = '/some/canonical/path';
    const fullHex = createHash('sha256').update(path).digest('hex');
    expect(inlineNamespace(path)).toBe(fullHex.slice(0, 12));
  });

  // ── pluginRootNamespace() vs inline algorithm ─────────────────────────────

  it('pluginRootNamespace produces the same result as the inline algorithm for a real path', () => {
    const canonical = realpathSync(tmpDir);
    const expected = inlineNamespace(canonical);
    expect(pluginRootNamespace(tmpDir)).toBe(expected);
  });

  it('pluginRootNamespace resolves symlinks before hashing (symlink and target share namespace)', () => {
    const target = join(tmpDir, 'real-install');
    mkdirSync(target);
    const link = join(tmpDir, 'symlink-install');
    symlinkSync(target, link);

    const nsViaTarget = pluginRootNamespace(target);
    const nsViaLink = pluginRootNamespace(link);

    expect(nsViaLink).toBe(nsViaTarget);
  });

  it('pluginRootNamespace throws when path does not exist (no silent fallback to raw path)', () => {
    const nonExistent = join(tmpDir, 'does-not-exist');
    expect(() => pluginRootNamespace(nonExistent)).toThrow();
  });

  it('two different real paths produce different namespaces', () => {
    const dirA = join(tmpDir, 'installA');
    const dirB = join(tmpDir, 'installB');
    mkdirSync(dirA);
    mkdirSync(dirB);

    expect(pluginRootNamespace(dirA)).not.toBe(pluginRootNamespace(dirB));
  });

  it('pluginRootNamespace output is always 12 hex chars', () => {
    const result = pluginRootNamespace(tmpDir);
    expect(result).toHaveLength(12);
    expect(result).toMatch(/^[0-9a-f]{12}$/);
  });

  // ── Regression: common algorithm mistakes ─────────────────────────────────

  it('algorithm does not use base64 encoding of the digest (which would change the character set)', () => {
    const path = realpathSync(tmpDir);
    const wrongBase64 = createHash('sha256').update(path).digest('base64').slice(0, 12);
    expect(pluginRootNamespace(tmpDir)).not.toBe(wrongBase64);
  });

  it('algorithm does not slice raw bytes (binary slice would differ from hex slice)', () => {
    const path = realpathSync(tmpDir);
    // Slicing raw buffer as hex is 2 chars/byte, so 12 hex = 6 bytes
    const wrongBytesHex = createHash('sha256').update(path).digest().slice(0, 12).toString('hex');
    // That would be 24 chars; verify our result is 12, not 24
    expect(pluginRootNamespace(tmpDir)).toHaveLength(12);
    expect(pluginRootNamespace(tmpDir)).not.toBe(wrongBytesHex);
  });
});
