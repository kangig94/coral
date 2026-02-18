import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';

describe('SessionManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('register → get → list round-trip', () => {
    const mgr = new SessionManager(tmpDir);
    const entry = mgr.register('my-session', 'thread-abc', 'o4-mini', tmpDir);

    expect(entry.name).toBe('my-session');
    expect(entry.codexThreadId).toBe('thread-abc');

    const found = mgr.get('my-session');
    expect(found).not.toBeNull();
    expect(found!.codexThreadId).toBe('thread-abc');

    const all = mgr.list();
    expect(all).toHaveLength(1);
  });

  it('finds by thread ID', () => {
    const mgr = new SessionManager(tmpDir);
    mgr.register('sess', 'thread-xyz', 'o4-mini', tmpDir);

    const found = mgr.get('thread-xyz');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('sess');
  });

  it('returns null for unknown session', () => {
    const mgr = new SessionManager(tmpDir);
    expect(mgr.get('nonexistent')).toBeNull();
  });

  it('updateSession updates timestamp and model', async () => {
    const mgr = new SessionManager(tmpDir);
    mgr.register('s1', 't1', 'old-model', tmpDir);
    const before = mgr.get('s1')!.lastUsedAt;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    mgr.updateSession('s1', { model: 'new-model' });
    const after = mgr.get('s1')!;
    expect(after.model).toBe('new-model');
    expect(after.lastUsedAt).not.toBe(before);
  });

  it('updateSession without model only updates timestamp', () => {
    const mgr = new SessionManager(tmpDir);
    mgr.register('s1', 't1', 'o4-mini', tmpDir);
    mgr.updateSession('s1');
    expect(mgr.get('s1')!.model).toBe('o4-mini');
  });

  it('remove deletes a session', () => {
    const mgr = new SessionManager(tmpDir);
    mgr.register('to-delete', 't1', 'o4-mini', tmpDir);
    expect(mgr.remove('to-delete')).toBe(true);
    expect(mgr.get('to-delete')).toBeNull();
  });

  it('remove returns false for nonexistent session', () => {
    const mgr = new SessionManager(tmpDir);
    expect(mgr.remove('nope')).toBe(false);
  });

  it('handles corrupted JSON file gracefully', () => {
    const registryPath = join(tmpDir, '.claude', 'coral', 'sessions.json');
    const dir = join(tmpDir, '.claude', 'coral');
    mkdirSync(dir, { recursive: true });
    writeFileSync(registryPath, '{invalid json!!!', 'utf-8');

    // Should not throw; logs warning to stderr
    const mgr = new SessionManager(tmpDir);
    expect(mgr.list()).toHaveLength(0);
  });

  it('returns empty registry for ENOENT (no file)', () => {
    const mgr = new SessionManager(tmpDir);
    expect(mgr.list()).toHaveLength(0);
  });

  it('uses atomic writes (tmp + rename)', () => {
    const mgr = new SessionManager(tmpDir);
    mgr.register('atomic-test', 't1', 'o4-mini', tmpDir);

    // After save, tmp file should not exist
    const tmpFile = join(tmpDir, '.claude', 'coral', 'sessions.json.tmp');
    expect(existsSync(tmpFile)).toBe(false);

    // Main file should exist with valid JSON
    const mainFile = join(tmpDir, '.claude', 'coral', 'sessions.json');
    const data = JSON.parse(readFileSync(mainFile, 'utf-8'));
    expect(data.sessions['atomic-test']).toBeDefined();
  });

  it('persists across instances', () => {
    const mgr1 = new SessionManager(tmpDir);
    mgr1.register('persistent', 't1', 'o4-mini', tmpDir);

    const mgr2 = new SessionManager(tmpDir);
    expect(mgr2.get('persistent')).not.toBeNull();
    expect(mgr2.get('persistent')!.codexThreadId).toBe('t1');
  });
});
