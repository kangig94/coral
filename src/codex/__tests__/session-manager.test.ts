import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

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

  function setup(projectName: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpDir, projectName);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir), workDir };
  }

  function sessionFilePath(workDir: string, name: string): string {
    return join(sessionDir(tmpDir, workDir), `${name}.json`);
  }

  function readSessionFile(workDir: string, name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(sessionFilePath(workDir, name), 'utf-8'));
  }

  it('register creates an individual session file', () => {
    const { mgr, workDir } = setup('project-a');

    const entry = mgr.register('my-session', 'thread-abc', 'o4-mini', workDir);

    expect(entry.name).toBe('my-session');
    expect(entry.sessionId).toBe('thread-abc');
    expect(existsSync(sessionFilePath(workDir, 'my-session'))).toBe(true);

    const fromDisk = readSessionFile(workDir, 'my-session');
    expect(fromDisk).toMatchObject({
      name: 'my-session',
      sessionId: 'thread-abc',
      model: 'o4-mini',
      workingDirectory: workDir,
    });
  });

  it('get finds a session by name via direct file lookup', () => {
    const { mgr, workDir } = setup('project-b');
    mgr.register('review', 'thread-1', 'o4-mini', workDir);

    const found = mgr.get('review');
    expect(found?.sessionId).toBe('thread-1');
  });

  it('get finds a session by sessionId via directory scan', () => {
    const { mgr, workDir } = setup('project-c');
    mgr.register('alpha', 'thread-alpha', 'o4-mini', workDir);
    mgr.register('beta', 'thread-beta', 'o4-mini', workDir);

    const found = mgr.get('thread-beta');
    expect(found?.name).toBe('beta');
  });

  it('list returns all valid sessions in the project directory', () => {
    const { mgr, workDir } = setup('project-d');
    mgr.register('one', 'thread-1', 'o4-mini', workDir);
    mgr.register('two', 'thread-2', 'o4-mini', workDir);

    const names = mgr
      .list()
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(['one', 'two']);
  });

  it('updateSession reads, mutates, and writes the session file', async () => {
    const { mgr, workDir } = setup('project-e');
    mgr.register('updatable', 'thread-up', 'old-model', workDir);

    const before = readSessionFile(workDir, 'updatable');

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    mgr.updateSession('updatable', { model: 'new-model' });

    const after = readSessionFile(workDir, 'updatable');
    expect(after.model).toBe('new-model');
    expect(after.lastUsedAt).not.toBe(before.lastUsedAt);
  });

  it('remove deletes the session file', () => {
    const { mgr, workDir } = setup('project-f');
    mgr.register('to-delete', 'thread-del', 'o4-mini', workDir);

    expect(existsSync(sessionFilePath(workDir, 'to-delete'))).toBe(true);
    expect(mgr.remove('to-delete')).toBe(true);
    expect(existsSync(sessionFilePath(workDir, 'to-delete'))).toBe(false);
  });

  it('corrupt session files are skipped gracefully', () => {
    const { mgr, workDir } = setup('project-g');
    mgr.register('valid', 'thread-valid', 'o4-mini', workDir);

    const brokenPath = join(sessionDir(tmpDir, workDir), 'broken.json');
    writeFileSync(brokenPath, '{invalid json!!!', 'utf-8');

    const all = mgr.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('valid');
    expect(mgr.get('broken')).toBeNull();
  });
});
