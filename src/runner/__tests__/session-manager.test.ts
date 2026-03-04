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
});
