import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('../codex-executor.js', () => ({
  executeOneShot: vi.fn(async () => ({
    response: 'ok',
    sessionId: 'thread-red-1',
    model: 'o4-mini',
    durationMs: 10,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
  executeResume: vi.fn(async () => ({
    response: 'ok',
    sessionId: 'thread-red-1',
    model: 'o4-mini',
    durationMs: 10,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
  executeFork: vi.fn(async () => ({
    response: 'ok',
    sessionId: 'thread-red-fork',
    model: 'o4-mini',
    durationMs: 10,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
}));

vi.mock('../cli-detection.js', () => ({
  detectCodexCli: vi.fn(async () => ({
    available: true,
    version: 'codex 1.0.0',
    authState: 'authenticated',
  })),
}));

import {
  createSessionDir,
  writeSessionResult,
  readSessionStatus,
  resolveSessionDir,
  SESSIONS_DIR,
} from '../progress.js';
import { codexOpSchema } from '../schemas.js';
import { handleToolCall, activeSessions } from '../server-handlers.js';
import { SessionManager } from '../session-manager.js';

describe('codex session API red checks', () => {
  let mgr: SessionManager;
  const dirsToClean = new Set<string>();

  beforeEach(() => {
    mgr = new SessionManager(process.cwd());
    activeSessions.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    for (const dir of dirsToClean) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirsToClean.clear();
  });

  it('createSessionDir returns id/dir and status can be resolved', () => {
    const { id, dir } = createSessionDir('red-session');
    dirsToClean.add(dir);

    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(dir.startsWith(SESSIONS_DIR)).toBe(true);
    expect(readSessionStatus(dir).status).toBe('running');
  });

  it('resolveSessionDir rejects invalid session IDs', () => {
    expect(() => resolveSessionDir('../../../etc/passwd')).toThrow();
    expect(() => resolveSessionDir('not-a-uuid')).toThrow();
  });

  it('schema enforces wait.sessions UUID array', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', sessions: [randomUUID()] }).success).toBe(true);
    expect(codexOpSchema.safeParse({ op: 'wait', sessions: [] }).success).toBe(false);
    expect(codexOpSchema.safeParse({ op: 'wait', sessions: ['bad-id'] }).success).toBe(false);
  });

  it('schema enforces abort.session UUID', () => {
    expect(codexOpSchema.safeParse({ op: 'abort', session: randomUUID() }).success).toBe(true);
    expect(codexOpSchema.safeParse({ op: 'abort', session: 'named-session' }).success).toBe(false);
    expect(codexOpSchema.safeParse({ op: 'abort' }).success).toBe(false);
  });

  it('exec response uses session/session_dir fields (no job_id/job_dir)', async () => {
    const result = await handleToolCall('codex', { op: 'exec', prompt: 'hello' }, mgr);
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(false);
    expect(data.session).toBeDefined();
    expect(data.session_dir).toBeDefined();
    expect(data.job_id).toBeUndefined();
    expect(data.job_dir).toBeUndefined();
  });

  it('wait response uses completed_session and session_dir', async () => {
    const id = randomUUID();
    const dir = join(SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    dirsToClean.add(dir);
    writeSessionResult(dir, 'done', { session_name: 'red-session' });

    const result = await handleToolCall('codex', { op: 'wait', sessions: [id] }, mgr);
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(false);
    expect(data.completed_session).toBe(id);
    expect(data.session_dir).toBe(dir);
    expect(data.completed_job_id).toBeUndefined();
  });

  it('abort uses session field (no job_id path)', async () => {
    const id = randomUUID();
    const controller = new AbortController();
    activeSessions.set(id, {
      sessionDir: '/tmp/red',
      controller,
      sessionName: 'red',
      terminalState: 'running',
    } as never);

    const result = await handleToolCall('codex', { op: 'abort', session: id }, mgr);
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(false);
    expect(data.session).toBe(id);
    expect(data.status).toBe('abort_requested');
    expect(controller.signal.aborted).toBe(true);
  });
});
