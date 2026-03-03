import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionDir,
  writeSessionResult,
  writeSessionError,
  readSessionStatus,
  resolveSessionDir,
  appendProgressEvent,
  formatElapsed,
  SESSIONS_DIR,
} from '../progress.js';

const dirsToClean: string[] = [];
afterEach(() => {
  for (const d of dirsToClean) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  dirsToClean.length = 0;
});

describe('formatElapsed', () => {
  it('returns empty string for undefined startedAt', () => {
    expect(formatElapsed(undefined)).toBe('');
  });

  it('formats durations', () => {
    const now = Date.now();
    expect(formatElapsed(now - 30_000)).toBe('30s');
    expect(formatElapsed(now - 90_000)).toBe('1m 30s');
    expect(formatElapsed(now - 3_600_000)).toBe('1h 0m 0s');
  });
});

describe('appendProgressEvent', () => {
  it('appends JSONL lines to progress file', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);
    const filePath = join(dir, 'progress.jsonl');

    appendProgressEvent(filePath, 'turn.started', 'Processing...');
    appendProgressEvent(filePath, 'item.completed', 'Searching: weather');

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'turn.started', message: 'Processing...' });
    expect(JSON.parse(lines[1])).toMatchObject({ event: 'item.completed', message: 'Searching: weather' });
  });
});

describe('createSessionDir', () => {
  it('creates session directory with status.json and progress.jsonl', () => {
    const { id, dir } = createSessionDir('test-session', 'claude');
    dirsToClean.push(dir);

    expect(existsSync(dir)).toBe(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('running');
    expect(status.provider).toBe('claude');
    expect(status.session_name).toBe('test-session');
    expect(status.startedAt).toBeTypeOf('number');
    expect(existsSync(join(dir, 'progress.jsonl'))).toBe(true);
  });

  it('defaults provider to codex for backwards compatibility', () => {
    const { dir } = createSessionDir('test-session');
    dirsToClean.push(dir);
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.provider).toBe('codex');
  });
});

describe('writeSessionResult', () => {
  it('writes result.md and sets status.json to completed', () => {
    const { dir } = createSessionDir('test', 'claude');
    dirsToClean.push(dir);

    writeSessionResult(dir, 'Hello world', {
      thread_id: 'thread-1',
      model: 'sonnet',
      session_name: 'test',
      duration_ms: 100,
    });

    const resultText = readFileSync(join(dir, 'result.md'), 'utf-8');
    expect(resultText).toBe('Hello world');

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('completed');
    expect(status.provider).toBe('claude');
    expect(status.thread_id).toBe('thread-1');
  });
});

describe('writeSessionError', () => {
  it('sets status.json to error with message', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);

    writeSessionError(dir, 'execution failed');

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('error');
    expect(status.provider).toBe('codex');
    expect(status.error).toBe('execution failed');
  });
});

describe('readSessionStatus', () => {
  it('returns running status from a fresh session dir', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);
    expect(readSessionStatus(dir).status).toBe('running');
  });

  it('returns running when status.json is missing', () => {
    const dir = join(tmpdir(), `coral-test-missing-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirsToClean.push(dir);
    expect(readSessionStatus(dir).status).toBe('running');
  });
});

describe('resolveSessionDir', () => {
  it('returns path under SESSIONS_DIR for valid UUID', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const dir = resolveSessionDir(uuid);
    expect(dir).toContain(uuid);
    expect(dir.startsWith(SESSIONS_DIR)).toBe(true);
  });

  it('throws for invalid UUID format', () => {
    expect(() => resolveSessionDir('not-a-uuid')).toThrow('Invalid session ID format');
  });
});
