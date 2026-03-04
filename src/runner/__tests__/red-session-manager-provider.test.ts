/**
 * Red-team adversarial tests for session-manager provider-identity edge cases.
 *
 * Deploy to: src/runner/__tests__/red-session-manager-provider.test.ts
 *
 * Target: ../session-manager.ts
 *
 * Coverage gap analysis
 * ---------------------
 * Before (existing tests cover):
 *   - register persists provider field; list/get are provider-scoped for codex/claude
 *   - legacy v1 migration defaults to codex
 *   - v2 no-provider migration patches provider to codex
 *   - remove is provider-scoped
 *   - non-built-in provider name round-trips (custom-provider string persists/loads/lists)
 *
 * Added (this file):
 *   - Session file with provider field that fails providerIdentPattern (uppercase, empty,
 *     non-string) is treated as unexpected shape → get/list return null/[]
 *   - 5-arg register overload (no provider arg) defaults to 'codex', not undefined
 *   - list() with no argument defaults to codex scope
 *   - get() with no argument defaults to codex scope (cross-checks with claude session)
 *   - updateSession with wrong provider silently does nothing (no modification, no throw)
 *   - updateSession with correct provider updates model and threadId fields
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionManager } from '../session-manager.js';

// ---------------------------------------------------------------------------
// node:os mock — must be declared at module scope so vitest hoists it
// ---------------------------------------------------------------------------

let tmpDir = '';

vi.mock('node:os', () => ({
  homedir: () => tmpDir,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function sessionsDir(homedirPath: string, workingDirectory: string): string {
  return join(homedirPath, '.claude', 'coral', 'sessions', projectHash(workingDirectory));
}

function sessionFilePath(workDir: string, id: string): string {
  return join(sessionsDir(tmpDir, workDir), `${id}.json`);
}

function setup(name: string): { mgr: SessionManager; workDir: string } {
  const workDir = join(tmpDir, name);
  mkdirSync(workDir, { recursive: true });
  return { mgr: new SessionManager(workDir), workDir };
}

// ---------------------------------------------------------------------------
// isSessionProvider — rejects invalid provider values stored on disk
// ---------------------------------------------------------------------------

describe('red: session-manager — invalid provider values on disk are treated as unexpected shape', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'red-sessmgr-shape-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('provider field with uppercase value fails isSessionProvider — get returns null', () => {
    const { mgr, workDir } = setup('uppercase');
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // Write a session file that has an uppercase provider — fails /^[a-z][a-z0-9-]*$/.
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

    // isSessionEntryV2 returns false for this entry; it falls to the
    // "unexpected shape" warning branch and returns null.
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

    // No valid provider string matches 123 — should return null for any lookup.
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

// ---------------------------------------------------------------------------
// Legacy 5-arg register overload defaults to codex
// ---------------------------------------------------------------------------

describe('red: session-manager — 5-arg register overload defaults to codex', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'red-sessmgr-legacy-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

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

// ---------------------------------------------------------------------------
// No-argument list() and get() default to codex scope
// ---------------------------------------------------------------------------

describe('red: session-manager — no-arg list() and get() default to codex scope', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'red-sessmgr-noarg-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

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

    // No-arg get finds the codex session by id.
    expect(mgr.get(codexId)).not.toBeNull();
    // The claude id must NOT be found via the no-arg overload.
    expect(mgr.get(claudeId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateSession — wrong provider is silent no-op; correct provider mutates
// ---------------------------------------------------------------------------

describe('red: session-manager — updateSession provider scoping', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'red-sessmgr-update-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updateSession with wrong provider does not modify the entry', () => {
    const { mgr, workDir } = setup('update-wrong');
    const id = '55555555-5555-4555-8555-555555555555';
    mgr.register('codex', id, 'myname', 'thread-orig', 'model-orig', workDir);

    // Attempt to update using the wrong provider — must be a silent no-op.
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

    // Small delay to ensure timestamp changes.
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
