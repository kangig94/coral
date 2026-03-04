import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexThreadEvent } from '../../../types.js';
import {
  createSessionDir,
  writeSessionResult,
  writeSessionError,
  readSessionStatus,
  resolveSessionDir,
  extractProgressMessage,
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

describe('extractProgressMessage', () => {
  it('returns "Processing..." for turn.started', () => {
    const event: CodexThreadEvent = { type: 'turn.started' };
    expect(extractProgressMessage(event)).toBe('Processing...');
  });

  it('returns reasoning text truncated to 120 chars', () => {
    const text = 'A'.repeat(200);
    const event: CodexThreadEvent = {
      type: 'item.completed',
      item: { id: '1', type: 'reasoning', text },
    };
    expect(extractProgressMessage(event)).toBe('A'.repeat(120));
  });

  it('returns search query for web_search', () => {
    const event: CodexThreadEvent = {
      type: 'item.completed',
      item: { id: '1', type: 'web_search', query: 'Seoul weather', action: null },
    };
    expect(extractProgressMessage(event)).toBe('Searching: Seoul weather');
  });

  it('returns "Generating response..." for agent_message', () => {
    const event: CodexThreadEvent = {
      type: 'item.completed',
      item: { id: '1', type: 'agent_message', text: 'hello' },
    };
    expect(extractProgressMessage(event)).toBe('Generating response...');
  });

  it('returns command for command_execution', () => {
    const event: CodexThreadEvent = {
      type: 'item.completed',
      item: { id: '1', type: 'command_execution', command: 'ls -la', aggregated_output: '', exit_code: 0, status: 'completed' },
    };
    expect(extractProgressMessage(event)).toBe('Running: ls -la');
  });

  it('returns file path for file_change', () => {
    const event: CodexThreadEvent = {
      type: 'item.completed',
      item: { id: '1', type: 'file_change', changes: [{ path: 'src/main.ts', kind: 'edit' }], status: 'completed' },
    };
    expect(extractProgressMessage(event)).toBe('Editing: src/main.ts');
  });

  it('returns tool name for mcp_tool_call', () => {
    const event: CodexThreadEvent = {
      type: 'item.completed',
      item: { id: '1', type: 'mcp_tool_call', server: 'srv', tool: 'my_tool', arguments: {}, result: null, error: null, status: 'completed' },
    };
    expect(extractProgressMessage(event)).toBe('Calling: my_tool');
  });

  it('returns null for turn.completed', () => {
    const event: CodexThreadEvent = {
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 30 },
    };
    expect(extractProgressMessage(event)).toBeNull();
  });

  it('returns null for thread.started', () => {
    const event: CodexThreadEvent = { type: 'thread.started', thread_id: 't1' };
    expect(extractProgressMessage(event)).toBeNull();
  });

  it('returns null for item.started', () => {
    const event: CodexThreadEvent = {
      type: 'item.started',
      item: { id: '1', type: 'reasoning', text: 'thinking' },
    };
    expect(extractProgressMessage(event)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('returns empty string for undefined startedAt', () => {
    expect(formatElapsed(undefined)).toBe('');
  });

  it('formats seconds only when under 60s', () => {
    const now = Date.now();
    expect(formatElapsed(now)).toBe('0s');
    expect(formatElapsed(now - 30_000)).toBe('30s');
    expect(formatElapsed(now - 59_000)).toBe('59s');
  });

  it('formats minutes and seconds from 60s to 59m 59s', () => {
    const now = Date.now();
    expect(formatElapsed(now - 60_000)).toBe('1m 0s');
    expect(formatElapsed(now - 90_000)).toBe('1m 30s');
    expect(formatElapsed(now - 3_599_000)).toBe('59m 59s');
  });

  it('formats hours, minutes, seconds from 60m onward', () => {
    const now = Date.now();
    expect(formatElapsed(now - 3_600_000)).toBe('1h 0m 0s');
    expect(formatElapsed(now - 5_430_000)).toBe('1h 30m 30s');
  });

  it('handles future startedAt gracefully', () => {
    expect(formatElapsed(Date.now() + 10_000)).toBe('0s');
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

    const event1 = JSON.parse(lines[0]);
    expect(event1.event).toBe('turn.started');
    expect(event1.message).toBe('Processing...');
    expect(event1.ts).toBeTypeOf('number');

    const event2 = JSON.parse(lines[1]);
    expect(event2.event).toBe('item.completed');
    expect(event2.message).toBe('Searching: weather');
  });

  it('does not throw on invalid file path', () => {
    expect(() => appendProgressEvent('/nonexistent/path/file.jsonl', 'test', 'msg')).not.toThrow();
  });
});

describe('createSessionDir', () => {
  it('creates session directory with status.json and progress.jsonl', () => {
    const { id, dir } = createSessionDir('test-session');
    dirsToClean.push(dir);

    expect(existsSync(dir)).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('running');
    expect(status.session_name).toBe('test-session');
    expect(status.startedAt).toBeTypeOf('number');
    expect(existsSync(join(dir, 'progress.jsonl'))).toBe(true);
  });

  it('creates unique session IDs for concurrent calls', () => {
    const { id: id1, dir: dir1 } = createSessionDir('session');
    const { id: id2, dir: dir2 } = createSessionDir('session');
    dirsToClean.push(dir1, dir2);

    expect(id1).not.toBe(id2);
  });

  it('session dir is under SESSIONS_DIR', () => {
    const { dir } = createSessionDir('s');
    dirsToClean.push(dir);

    expect(dir.startsWith(SESSIONS_DIR)).toBe(true);
  });
});

describe('writeSessionResult', () => {
  it('writes result.md and sets status.json to completed', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);

    writeSessionResult(dir, 'Hello world', {
      thread_id: 'thread-1',
      model: 'o4-mini',
      session_name: 'test',
      duration_ms: 100,
    });

    const resultText = readFileSync(join(dir, 'result.md'), 'utf-8');
    expect(resultText).toBe('Hello world');

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('completed');
    expect(status.thread_id).toBe('thread-1');
  });

  it('is idempotent when already completed', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);

    writeSessionResult(dir, 'first', { session_name: 'test' });
    writeSessionResult(dir, 'second', { session_name: 'test' });

    expect(readFileSync(join(dir, 'result.md'), 'utf-8')).toBe('first');
  });
});

describe('writeSessionError', () => {
  it('sets status.json to error with message', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);

    writeSessionError(dir, 'Codex timed out');

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.status).toBe('error');
    expect(status.error).toBe('Codex timed out');
    expect(status.session_name).toBe('test');
  });

  it('does not write result.md', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);

    writeSessionError(dir, 'error');

    expect(existsSync(join(dir, 'result.md'))).toBe(false);
  });

  it('is idempotent when already errored', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);

    writeSessionError(dir, 'first error');
    writeSessionError(dir, 'second error');

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf-8'));
    expect(status.error).toBe('first error');
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

  it('returns completed after writeSessionResult', () => {
    const { dir } = createSessionDir('test');
    dirsToClean.push(dir);

    writeSessionResult(dir, 'done', { session_name: 'test' });
    expect(readSessionStatus(dir).status).toBe('completed');
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

  it('throws for empty string', () => {
    expect(() => resolveSessionDir('')).toThrow();
  });
});
