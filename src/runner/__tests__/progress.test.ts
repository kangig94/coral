import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProgressCursor,
  createSessionDir,
  writeSessionResult,
  writeSessionError,
  readSessionStatus,
  resolveSessionDir,
  appendProgressEvent,
  formatElapsed,
  readProgressEvents,
  PROGRESS_FILE,
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

describe('readProgressEvents', () => {
  it('returns typed events from valid JSONL lines', () => {
    const { dir } = createSessionDir('progress-read');
    dirsToClean.push(dir);
    const progressFile = join(dir, PROGRESS_FILE);
    writeFileSync(progressFile, `${JSON.stringify({ ts: 1, event: 'a', message: 'm1' })}\n`, 'utf-8');

    const cursor = createProgressCursor();
    const events = readProgressEvents(progressFile, cursor);

    expect(events).toEqual([{ ts: 1, event: 'a', message: 'm1' }]);
  });

  it('skips malformed JSON and lines without message', () => {
    const { dir } = createSessionDir('progress-skip-malformed');
    dirsToClean.push(dir);
    const progressFile = join(dir, PROGRESS_FILE);
    writeFileSync(
      progressFile,
      `${JSON.stringify({ ts: 1, event: 'ok', message: 'good' })}\nnot-json\n${JSON.stringify({ ts: 2, event: 'noop' })}\n`,
      'utf-8',
    );

    const cursor = createProgressCursor();
    const events = readProgressEvents(progressFile, cursor);

    expect(events).toEqual([{ ts: 1, event: 'ok', message: 'good' }]);
  });

  it('advances cursor incrementally and returns only new events', () => {
    const { dir } = createSessionDir('progress-incremental');
    dirsToClean.push(dir);
    const progressFile = join(dir, PROGRESS_FILE);
    writeFileSync(progressFile, `${JSON.stringify({ ts: 1, event: 'a', message: 'first' })}\n`, 'utf-8');

    const cursor = createProgressCursor();
    expect(readProgressEvents(progressFile, cursor).map((event) => event.message)).toEqual(['first']);

    appendFileSync(progressFile, `${JSON.stringify({ ts: 2, event: 'b', message: 'second' })}\n`, 'utf-8');
    expect(readProgressEvents(progressFile, cursor).map((event) => event.message)).toEqual(['second']);
  });

  it('returns empty array for missing progress file', () => {
    const cursor = createProgressCursor();
    const missingFile = join(tmpdir(), `coral-progress-missing-${Date.now()}.jsonl`);
    expect(readProgressEvents(missingFile, cursor)).toEqual([]);
  });

  it('handles partial lines with cursor remainder', () => {
    const { dir } = createSessionDir('progress-remainder');
    dirsToClean.push(dir);
    const progressFile = join(dir, PROGRESS_FILE);
    const partial = JSON.stringify({ ts: 2, event: 'delta', message: 'second' });
    writeFileSync(progressFile, `${JSON.stringify({ ts: 1, event: 'delta', message: 'first' })}\n${partial}`, 'utf-8');

    const cursor = createProgressCursor();
    expect(readProgressEvents(progressFile, cursor).map((event) => event.message)).toEqual(['first']);

    appendFileSync(progressFile, '\n', 'utf-8');
    expect(readProgressEvents(progressFile, cursor).map((event) => event.message)).toEqual(['second']);
  });

  it('filters out lines where message is empty string (falsy guard)', () => {
    const { dir } = createSessionDir('progress-empty-msg');
    dirsToClean.push(dir);
    const file = join(dir, PROGRESS_FILE);
    writeFileSync(
      file,
      `${JSON.stringify({ ts: 1, event: 'e', message: '' })}\n` +
      `${JSON.stringify({ ts: 2, event: 'e', message: 'real' })}\n`,
      'utf-8',
    );
    const cursor = createProgressCursor();
    const events = readProgressEvents(file, cursor);
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('real');
  });

  it('defaults ts to 0 and event to empty string when fields are absent', () => {
    const { dir } = createSessionDir('progress-missing-fields');
    dirsToClean.push(dir);
    const file = join(dir, PROGRESS_FILE);
    writeFileSync(
      file,
      `${JSON.stringify({ message: 'only-message' })}\n`,
      'utf-8',
    );
    const cursor = createProgressCursor();
    const events = readProgressEvents(file, cursor);
    expect(events).toHaveLength(1);
    expect(events[0].ts).toBe(0);
    expect(events[0].event).toBe('');
    expect(events[0].message).toBe('only-message');
  });

  it('cursor state is stable when file does not grow between calls', () => {
    const { dir } = createSessionDir('progress-no-growth');
    dirsToClean.push(dir);
    const file = join(dir, PROGRESS_FILE);
    writeFileSync(
      file,
      `${JSON.stringify({ ts: 1, event: 'a', message: 'msg' })}\n`,
      'utf-8',
    );
    const cursor = createProgressCursor();
    const first = readProgressEvents(file, cursor);
    expect(first).toHaveLength(1);
    const offsetAfterFirst = cursor.lastOffset;
    const second = readProgressEvents(file, cursor);
    expect(second).toHaveLength(0);
    expect(cursor.lastOffset).toBe(offsetAfterFirst);
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
