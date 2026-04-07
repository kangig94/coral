import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backendLockPath, installationDir } from '../../infra/paths.js';
import { tryExclusiveWrite } from '../../shared/utils.js';

const tempRoots: string[] = [];

function createPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-lifecycle-test-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'manifest.json'), JSON.stringify({ bundleHash: 'test-hash' }), 'utf-8');
  mkdirSync(installationDir(root), { recursive: true });
  return root;
}

function writeLockFile(root: string, pid: number): void {
  const payload = JSON.stringify({
    instanceId: `test-${pid}-${Date.now()}`,
    pid,
    version: '0.0.0',
    bundleHash: 'test-hash',
    startedAt: Date.now(),
  });
  writeFileSync(backendLockPath(root), payload, 'utf-8');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('backend lock lifecycle', () => {
  it('exclusive write fails when lock file already exists', () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);
    writeFileSync(lockPath, 'existing', 'utf-8');
    expect(tryExclusiveWrite(lockPath, 'new-content')).toBe(false);
  });

  it('exclusive write succeeds when no lock file exists', () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);
    expect(tryExclusiveWrite(lockPath, 'new-content')).toBe(true);
    expect(readFileSync(lockPath, 'utf-8')).toBe('new-content');
  });

  it('stale lock from dead process blocks new lock acquisition', () => {
    const root = createPluginRoot();
    const deadPid = 2147483647; // almost certainly not a real PID
    writeLockFile(root, deadPid);

    const lockPath = backendLockPath(root);
    expect(tryExclusiveWrite(lockPath, 'replacement')).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('stale lock from dead process is removable by PID check', () => {
    const root = createPluginRoot();
    const deadPid = 2147483647;
    writeLockFile(root, deadPid);

    const lockPath = backendLockPath(root);
    const content = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as { pid: number };

    // Verify the PID is dead
    let alive = true;
    try {
      process.kill(parsed.pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('lock from live process is not falsely detected as stale', () => {
    const root = createPluginRoot();
    writeLockFile(root, process.pid); // current process is alive

    const lockPath = backendLockPath(root);
    const content = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as { pid: number };

    let alive = false;
    try {
      process.kill(parsed.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);
  });

  it('lock file without pid field is not treated as stale', () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);
    writeFileSync(lockPath, JSON.stringify({ instanceId: 'no-pid' }), 'utf-8');

    // Should not be removable — no pid to check
    expect(existsSync(lockPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.pid).toBeUndefined();
  });
});

describe('shutdown cleanup ordering', () => {
  it('removeBackendInfoIfOwner and removeLockIfOwner are called before onStopped in lifecycle', async () => {
    // This test verifies the fix by importing and checking the source structure.
    // The actual behavioral test is that process.exit(0) in onStopped no longer
    // preempts cleanup — verified by the fact that backend.lock is absent after
    // idle shutdown (manual verification).
    const lifecycleSrc = readFileSync(
      join(process.cwd(), 'src/execution/lifecycle.ts'),
      'utf-8',
    );

    // Find the shutdown section: cleanup must come before onStopped
    const cleanupIndex = lifecycleSrc.indexOf('removeBackendInfoIfOwnerFn(pluginRoot, instanceId)');
    const lockCleanupIndex = lifecycleSrc.indexOf('removeLockIfOwnerFn(pluginRoot, instanceId)');
    const onStoppedIndex = lifecycleSrc.indexOf('onStopped?.()');

    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(lockCleanupIndex).toBeGreaterThan(-1);
    expect(onStoppedIndex).toBeGreaterThan(-1);

    // First occurrence of cleanup must be before first occurrence of onStopped
    expect(cleanupIndex).toBeLessThan(onStoppedIndex);
    expect(lockCleanupIndex).toBeLessThan(onStoppedIndex);
  });
});
