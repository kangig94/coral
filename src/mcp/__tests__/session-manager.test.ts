import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';

let tmpDir = '';

vi.mock('node:os', () => ({
  homedir: () => tmpDir,
}));

import { SessionManager } from '../session-manager.js';

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function sessionDir(homedirPath: string, workingDirectory: string): string {
  return join(homedirPath, '.claude', 'coral', 'sessions', projectHash(workingDirectory));
}

describe('SessionManager', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('register creates an individual session file', () => {
    const workingDirectory = join(tmpDir, 'project-a');
    mkdirSync(workingDirectory, { recursive: true });
    const mgr = new SessionManager(workingDirectory);

    const entry = mgr.register('my-session', 'thread-abc', 'o4-mini', workingDirectory);
    const expectedPath = join(sessionDir(tmpDir, workingDirectory), 'my-session.json');

    expect(entry.name).toBe('my-session');
    expect(entry.codexThreadId).toBe('thread-abc');
    expect(existsSync(expectedPath)).toBe(true);

    const fromDisk = JSON.parse(readFileSync(expectedPath, 'utf-8')) as {
      name: string;
      codexThreadId: string;
      model: string;
      workingDirectory: string;
    };
    expect(fromDisk.name).toBe('my-session');
    expect(fromDisk.codexThreadId).toBe('thread-abc');
    expect(fromDisk.model).toBe('o4-mini');
    expect(fromDisk.workingDirectory).toBe(workingDirectory);
  });

  it('get finds a session by name via direct file lookup', () => {
    const workingDirectory = join(tmpDir, 'project-b');
    mkdirSync(workingDirectory, { recursive: true });
    const mgr = new SessionManager(workingDirectory);
    mgr.register('review', 'thread-1', 'o4-mini', workingDirectory);

    const found = mgr.get('review');
    expect(found).not.toBeNull();
    expect(found!.codexThreadId).toBe('thread-1');
  });

  it('get finds a session by threadId via directory scan', () => {
    const workingDirectory = join(tmpDir, 'project-c');
    mkdirSync(workingDirectory, { recursive: true });
    const mgr = new SessionManager(workingDirectory);
    mgr.register('alpha', 'thread-alpha', 'o4-mini', workingDirectory);
    mgr.register('beta', 'thread-beta', 'o4-mini', workingDirectory);

    const found = mgr.get('thread-beta');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('beta');
  });

  it('list returns all valid sessions in the project directory', () => {
    const workingDirectory = join(tmpDir, 'project-d');
    mkdirSync(workingDirectory, { recursive: true });
    const mgr = new SessionManager(workingDirectory);
    mgr.register('one', 'thread-1', 'o4-mini', workingDirectory);
    mgr.register('two', 'thread-2', 'o4-mini', workingDirectory);

    const names = mgr
      .list()
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(['one', 'two']);
  });

  it('updateSession reads, mutates, and writes the session file', async () => {
    const workingDirectory = join(tmpDir, 'project-e');
    mkdirSync(workingDirectory, { recursive: true });
    const mgr = new SessionManager(workingDirectory);
    mgr.register('updatable', 'thread-up', 'old-model', workingDirectory);

    const filePath = join(sessionDir(tmpDir, workingDirectory), 'updatable.json');
    const before = JSON.parse(readFileSync(filePath, 'utf-8')) as { lastUsedAt: string; model: string };

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    mgr.updateSession('updatable', { model: 'new-model' });

    const after = JSON.parse(readFileSync(filePath, 'utf-8')) as { lastUsedAt: string; model: string };
    expect(after.model).toBe('new-model');
    expect(after.lastUsedAt).not.toBe(before.lastUsedAt);
  });

  it('remove deletes the session file', () => {
    const workingDirectory = join(tmpDir, 'project-f');
    mkdirSync(workingDirectory, { recursive: true });
    const mgr = new SessionManager(workingDirectory);
    mgr.register('to-delete', 'thread-del', 'o4-mini', workingDirectory);

    const filePath = join(sessionDir(tmpDir, workingDirectory), 'to-delete.json');
    expect(existsSync(filePath)).toBe(true);
    expect(mgr.remove('to-delete')).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('corrupt session files are skipped gracefully', () => {
    const workingDirectory = join(tmpDir, 'project-g');
    mkdirSync(workingDirectory, { recursive: true });
    const mgr = new SessionManager(workingDirectory);
    mgr.register('valid', 'thread-valid', 'o4-mini', workingDirectory);

    const brokenPath = join(sessionDir(tmpDir, workingDirectory), 'broken.json');
    writeFileSync(brokenPath, '{invalid json!!!', 'utf-8');

    const all = mgr.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('valid');
    expect(mgr.get('broken')).toBeNull();
  });
});
