import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

let tmpDir = '';

vi.mock('node:os', () => ({
  homedir: () => tmpDir,
}));

import { SessionManager } from '../../../runner/session-manager.js';

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function sessionsDir(homedirPath: string, workingDirectory: string): string {
  return join(homedirPath, '.claude', 'coral', 'sessions', projectHash(workingDirectory));
}

describe('SessionManager', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup(projectName: string): { mgr: SessionManager; workDir: string } {
    const workDir = join(tmpDir, projectName);
    mkdirSync(workDir, { recursive: true });
    return { mgr: new SessionManager(workDir), workDir };
  }

  function sessionFilePath(workDir: string, id: string): string {
    return join(sessionsDir(tmpDir, workDir), `${id}.json`);
  }

  function readSessionFile(workDir: string, id: string): Record<string, unknown> {
    return JSON.parse(readFileSync(sessionFilePath(workDir, id), 'utf-8'));
  }

  it('register creates an individual UUID-keyed session file', () => {
    const { mgr, workDir } = setup('project-a');
    const id = '11111111-1111-4111-8111-111111111111';

    const entry = mgr.register('codex', id, 'my-session', 'thread-abc', 'o4-mini', workDir);

    expect(entry.id).toBe(id);
    expect(entry.name).toBe('my-session');
    expect(entry.threadId).toBe('thread-abc');
    expect(existsSync(sessionFilePath(workDir, id))).toBe(true);

    const fromDisk = readSessionFile(workDir, id);
    expect(fromDisk).toMatchObject({
      id,
      name: 'my-session',
      threadId: 'thread-abc',
      model: 'o4-mini',
      workingDirectory: workDir,
    });
  });

  it('get finds a session by UUID via direct file lookup', () => {
    const { mgr, workDir } = setup('project-b');
    const id = '22222222-2222-4222-8222-222222222222';
    mgr.register('codex', id, 'review', 'thread-1', 'o4-mini', workDir);

    const found = mgr.get('codex', id);
    expect(found?.threadId).toBe('thread-1');
    expect(found?.id).toBe(id);
  });

  it('get does not fall back to name scan (UUID-only direct lookup)', () => {
    const { mgr, workDir } = setup('project-c');
    const id = '33333333-3333-4333-8333-333333333333';
    mgr.register('codex', id, 'alpha', 'thread-alpha', 'o4-mini', workDir);

    // Name-based lookup must return null — no directory scan fallback
    expect(mgr.get('codex', 'alpha')).toBeNull();
    // UUID-based lookup still resolves correctly
    expect(mgr.get('codex', id)?.id).toBe(id);
  });

  it('list returns all valid sessions in the project directory', () => {
    const { mgr, workDir } = setup('project-d');
    mgr.register('codex', '44444444-4444-4444-8444-444444444444', 'one', 'thread-1', 'o4-mini', workDir);
    mgr.register('codex', '55555555-5555-4555-8555-555555555555', 'two', 'thread-2', 'o4-mini', workDir);

    const names = mgr
      .list('codex')
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(['one', 'two']);
  });

  it('updateSession updates by UUID', async () => {
    const { mgr, workDir } = setup('project-e');
    const id = '66666666-6666-4666-8666-666666666666';
    mgr.register('codex', id, 'updatable', 'thread-up', 'old-model', workDir);

    const before = readSessionFile(workDir, id);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    mgr.updateSession('codex', id, { model: 'new-model' });

    const after = readSessionFile(workDir, id);
    expect(after.model).toBe('new-model');
    expect(after.lastUsedAt).not.toBe(before.lastUsedAt);
  });

  it('remove deletes the UUID-keyed session file', () => {
    const { mgr, workDir } = setup('project-f');
    const id = '77777777-7777-4777-8777-777777777777';
    mgr.register('codex', id, 'to-delete', 'thread-del', 'o4-mini', workDir);

    expect(existsSync(sessionFilePath(workDir, id))).toBe(true);
    expect(mgr.remove('codex', id)).toBe(true);
    expect(existsSync(sessionFilePath(workDir, id))).toBe(false);
  });

  it('v2 shape validation: files with wrong shape are warned and skipped', () => {
    const { mgr, workDir } = setup('project-g');
    const goodId = '88888888-8888-4888-8888-888888888888';
    const badId = '99999999-9999-4999-8999-999999999999';
    mgr.register('codex', goodId, 'valid', 'thread-valid', 'o4-mini', workDir);
    writeFileSync(sessionFilePath(workDir, badId), JSON.stringify({ id: badId, name: 'bad', model: 'o4-mini' }), 'utf-8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(mgr.get('codex', badId)).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(`Session file ${badId}.json has unexpected shape`));

    const all = mgr.list('codex');
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(goodId);
  });

  it('corrupt session files are skipped gracefully', () => {
    const { mgr, workDir } = setup('project-h');
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mgr.register('codex', id, 'valid', 'thread-valid', 'o4-mini', workDir);

    const brokenId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeFileSync(sessionFilePath(workDir, brokenId), '{invalid json!!!', 'utf-8');

    const all = mgr.list('codex');
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('valid');
    expect(mgr.get('codex', brokenId)).toBeNull();
  });

  it('get() with empty string id returns null without throwing', () => {
    const { mgr } = setup('empty-get');
    expect(() => mgr.get('codex', '')).not.toThrow();
    expect(mgr.get('codex', '')).toBeNull();
  });
});
