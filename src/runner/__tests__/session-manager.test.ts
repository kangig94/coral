import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionManager } from '../session-manager.js';

let tmpDir = '';

vi.mock('node:os', () => ({
  homedir: () => tmpDir,
}));

const LEGACY_SESSION_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf-8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
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

  it('legacy v1 migration defaults provider to codex', () => {
    const workDir = join(tmpDir, 'legacy-v1');
    mkdirSync(workDir, { recursive: true });
    const dir = sessionsDir(tmpDir, workDir);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'legacy-name.json'), JSON.stringify({
      name: 'legacy-name',
      sessionId: 'thread-legacy',
      model: 'o4-mini',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: '2024-01-02T00:00:00.000Z',
      workingDirectory: '/legacy/workdir',
    }), 'utf-8');

    const mgr = new SessionManager(workDir);
    const migratedId = uuidV5(LEGACY_SESSION_NAMESPACE, 'legacy-name');
    const found = mgr.get('codex', migratedId);

    expect(found).not.toBeNull();
    expect(found?.provider).toBe('codex');
  });

  it('v2 no-provider session is migrated in-place to provider codex', () => {
    const { mgr, workDir } = setup('legacy-v2-no-provider');
    const id = '33333333-3333-4333-8333-333333333333';
    writeFileSync(sessionFilePath(workDir, id), JSON.stringify({
      id,
      name: 'no-provider',
      threadId: 'thread-legacy',
      model: 'o4-mini',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: '2024-01-01T00:00:00.000Z',
      workingDirectory: workDir,
    }, null, 2), 'utf-8');

    const found = mgr.get('codex', id);
    expect(found).not.toBeNull();
    expect(found?.provider).toBe('codex');

    const onDisk = JSON.parse(readFileSync(sessionFilePath(workDir, id), 'utf-8'));
    expect(onDisk.provider).toBe('codex');
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

  describe('5-arg register overload defaults to codex', () => {
    it('5-arg register (no provider) persists provider=codex on disk', () => {
      const { mgr, workDir } = setup('legacy-register');
      const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

      const entry = mgr.register(id, 'myname', 'thread', 'model', workDir);

      expect(entry.provider).toBe('codex');
      const onDisk = JSON.parse(readFileSync(sessionFilePath(workDir, id), 'utf-8')) as {
        provider: string;
      };
      expect(onDisk.provider).toBe('codex');
    });

    it('5-arg register result is retrievable via get("codex", id)', () => {
      const { mgr, workDir } = setup('legacy-get');
      const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      mgr.register(id, 'myname', 'thread', 'model', workDir);

      expect(mgr.get('codex', id)).not.toBeNull();
      expect(mgr.get('claude', id)).toBeNull();
    });
  });

  describe('no-arg list() and get() default to codex scope', () => {
    it('list() with no argument returns only codex sessions', () => {
      const { mgr, workDir } = setup('noarg-list');
      const codexId = '11111111-1111-4111-8111-111111111111';
      const claudeId = '22222222-2222-4222-8222-222222222222';

      mgr.register('codex', codexId, 'c', 'tc', 'mc', workDir);
      mgr.register('claude', claudeId, 'a', 'ta', 'ma', workDir);

      const listed = mgr.list();
      expect(listed.map((e) => e.id)).toContain(codexId);
      expect(listed.map((e) => e.id)).not.toContain(claudeId);
    });

    it('get(id) with no provider argument resolves codex scope', () => {
      const { mgr, workDir } = setup('noarg-get');
      const codexId = '33333333-3333-4333-8333-333333333333';
      const claudeId = '44444444-4444-4444-8444-444444444444';

      mgr.register('codex', codexId, 'c', 'tc', 'mc', workDir);
      mgr.register('claude', claudeId, 'a', 'ta', 'ma', workDir);

      expect(mgr.get(codexId)).not.toBeNull();
      expect(mgr.get(claudeId)).toBeNull();
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
