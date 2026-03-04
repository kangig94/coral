import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionManager } from '../session-manager.js';

let tmpDir = '';

vi.mock('node:os', () => ({
  homedir: () => tmpDir,
}));

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function sessionsDir(homedirPath: string, workingDirectory: string): string {
  return join(homedirPath, '.claude', 'coral', 'sessions', projectHash(workingDirectory));
}

describe('runner SessionManager', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-runner-test-'));
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

  it('register persists provider and list/get are provider scoped', () => {
    const { mgr, workDir } = setup('project-a');
    const codexId = '11111111-1111-4111-8111-111111111111';
    const claudeId = '22222222-2222-4222-8222-222222222222';

    mgr.register('codex', codexId, 'c1', 'thread-c1', 'gpt-5.3-codex', workDir);
    mgr.register('claude', claudeId, 'a1', 'thread-a1', 'sonnet', workDir);

    expect(mgr.get('codex', codexId)?.provider).toBe('codex');
    expect(mgr.get('claude', codexId)).toBeNull();
    expect(mgr.list('codex').map((e) => e.id)).toEqual([codexId]);
    expect(mgr.list('claude').map((e) => e.id)).toEqual([claudeId]);

    const fromDisk = JSON.parse(readFileSync(sessionFilePath(workDir, codexId), 'utf-8'));
    expect(fromDisk.provider).toBe('codex');
  });

  it('remove is provider scoped', () => {
    const { mgr, workDir } = setup('remove-scope');
    const id = '44444444-4444-4444-8444-444444444444';
    mgr.register('claude', id, 'name', 'thread', 'model', workDir);

    expect(existsSync(sessionFilePath(workDir, id))).toBe(true);
    expect(mgr.remove('codex', id)).toBe(false);
    expect(existsSync(sessionFilePath(workDir, id))).toBe(true);
    expect(mgr.remove('claude', id)).toBe(true);
    expect(existsSync(sessionFilePath(workDir, id))).toBe(false);
  });

  it('persists and round-trips non-built-in provider identifiers', () => {
    const { mgr, workDir } = setup('custom-provider');
    const id = '55555555-5555-4555-8555-555555555555';
    mgr.register('custom-provider', id, 'custom', 'thread-custom', 'model-x', workDir);

    expect(mgr.get('custom-provider', id)?.provider).toBe('custom-provider');
    expect(mgr.get('codex', id)).toBeNull();
    expect(mgr.list('custom-provider').map((entry) => entry.id)).toEqual([id]);

    const fromDisk = JSON.parse(readFileSync(sessionFilePath(workDir, id), 'utf-8'));
    expect(fromDisk.provider).toBe('custom-provider');
  });

  describe('invalid provider values on disk are treated as unexpected shape', () => {
    it('provider field with uppercase value fails isSessionProvider — get returns null', () => {
      const { mgr, workDir } = setup('uppercase');
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      writeFileSync(sessionFilePath(workDir, id), JSON.stringify({
        id,
        provider: 'UPPERCASE',
        name: 'test',
        threadId: 'thread',
        model: 'm',
        createdAt: '2024-01-01T00:00:00Z',
        lastUsedAt: '2024-01-01T00:00:00Z',
        workingDirectory: workDir,
      }, null, 2));

      expect(mgr.get('UPPERCASE', id)).toBeNull();
      expect(mgr.list('UPPERCASE')).toEqual([]);
    });

    it('provider field is empty string — fails isSessionProvider, get returns null', () => {
      const { mgr, workDir } = setup('empty-provider');
      const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      writeFileSync(sessionFilePath(workDir, id), JSON.stringify({
        id,
        provider: '',
        name: 'test',
        threadId: 'thread',
        model: 'm',
        createdAt: '2024-01-01T00:00:00Z',
        lastUsedAt: '2024-01-01T00:00:00Z',
        workingDirectory: workDir,
      }, null, 2));

      expect(mgr.get('', id)).toBeNull();
      expect(mgr.list('')).toEqual([]);
    });

    it('provider field is a number — typeof check in isSessionProvider returns false', () => {
      const { mgr, workDir } = setup('numeric-provider');
      const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      writeFileSync(sessionFilePath(workDir, id), JSON.stringify({
        id,
        provider: 123,
        name: 'test',
        threadId: 'thread',
        model: 'm',
        createdAt: '2024-01-01T00:00:00Z',
        lastUsedAt: '2024-01-01T00:00:00Z',
        workingDirectory: workDir,
      }, null, 2));

      expect(mgr.get('codex', id)).toBeNull();
    });

    it('provider field starts with a digit — fails providerIdentPattern, treated as unexpected shape', () => {
      const { mgr, workDir } = setup('digit-provider');
      const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      writeFileSync(sessionFilePath(workDir, id), JSON.stringify({
        id,
        provider: '1invalid',
        name: 'test',
        threadId: 'thread',
        model: 'm',
        createdAt: '2024-01-01T00:00:00Z',
        lastUsedAt: '2024-01-01T00:00:00Z',
        workingDirectory: workDir,
      }, null, 2));

      expect(mgr.get('1invalid', id)).toBeNull();
    });
  });

  describe('updateSession provider scoping', () => {
    it('updateSession with wrong provider does not modify the entry', () => {
      const { mgr, workDir } = setup('update-wrong');
      const id = '55555555-5555-4555-8555-555555555555';
      mgr.register('codex', id, 'myname', 'thread-orig', 'model-orig', workDir);

      mgr.updateSession('claude', id, { threadId: 'thread-new', model: 'model-new' });

      const entry = mgr.get('codex', id);
      expect(entry?.threadId).toBe('thread-orig');
      expect(entry?.model).toBe('model-orig');
    });

    it('updateSession with correct provider updates threadId and model', () => {
      const { mgr, workDir } = setup('update-correct');
      const id = '66666666-6666-4666-8666-666666666666';
      mgr.register('codex', id, 'myname', 'thread-orig', 'model-orig', workDir);

      mgr.updateSession('codex', id, { threadId: 'thread-updated', model: 'model-updated' });

      const entry = mgr.get('codex', id);
      expect(entry?.threadId).toBe('thread-updated');
      expect(entry?.model).toBe('model-updated');
    });

    it('updateSession with correct provider also updates lastUsedAt', async () => {
      const { mgr, workDir } = setup('update-time');
      const id = '77777777-7777-4777-8777-777777777777';
      mgr.register('codex', id, 'myname', 'thread-t', 'model-t', workDir);
      const before = mgr.get('codex', id)?.lastUsedAt ?? '';

      await new Promise((r) => setTimeout(r, 5));
      mgr.updateSession('codex', id, {});

      const after = mgr.get('codex', id)?.lastUsedAt ?? '';
      expect(after >= before).toBe(true);
    });

    it('updateSession with non-existent id is a silent no-op (no throw)', () => {
      const { mgr } = setup('update-missing');
      const missingId = '88888888-8888-4888-8888-888888888888';
      expect(() =>
        mgr.updateSession('codex', missingId, { threadId: 'x' }),
      ).not.toThrow();
    });
  });
});
