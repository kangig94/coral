import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { CodexThreadEvent } from '../../types.js';
import { extractProgressMessage, extractProgressId, createProgressFile, appendProgressEvent, appendFinalResult } from '../progress.js';

const filesToClean: string[] = [];
afterEach(() => {
  for (const f of filesToClean) {
    try { unlinkSync(f); } catch {}
  }
  filesToClean.length = 0;
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

describe('createProgressFile', () => {
  it('creates a JSONL file with metadata header', () => {
    const filePath = createProgressFile('test-session', 'codex_session_create');
    filesToClean.push(filePath);

    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain(tmpdir());
    expect(filePath).toMatch(/coral-progress-.+\.jsonl$/);

    const content = readFileSync(filePath, 'utf-8').trim();
    const meta = JSON.parse(content);
    expect(meta.progressId).toBeTypeOf('string');
    expect(meta.session).toBe('test-session');
    expect(meta.tool).toBe('codex_session_create');
    expect(meta.startedAt).toBeTypeOf('number');
  });

  it('generates unique file paths for concurrent calls', () => {
    const f1 = createProgressFile('same-name', 'codex_session_create');
    const f2 = createProgressFile('same-name', 'codex_session_create');
    filesToClean.push(f1, f2);

    expect(f1).not.toBe(f2);
  });
});

describe('appendProgressEvent', () => {
  it('appends JSONL lines to progress file', () => {
    const filePath = createProgressFile('test', 'codex_session_create');
    filesToClean.push(filePath);

    appendProgressEvent(filePath, 'turn.started', 'Processing...');
    appendProgressEvent(filePath, 'item.completed', 'Searching: weather');

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3); // 1 header + 2 events

    const event1 = JSON.parse(lines[1]);
    expect(event1.event).toBe('turn.started');
    expect(event1.message).toBe('Processing...');
    expect(event1.ts).toBeTypeOf('number');

    const event2 = JSON.parse(lines[2]);
    expect(event2.event).toBe('item.completed');
    expect(event2.message).toBe('Searching: weather');
  });

  it('does not throw on invalid file path', () => {
    expect(() => appendProgressEvent('/nonexistent/path/file.jsonl', 'test', 'msg')).not.toThrow();
  });
});

describe('extractProgressId', () => {
  it('extracts UUID from progress file path', () => {
    const filePath = createProgressFile('test', 'codex_session_create');
    filesToClean.push(filePath);

    const id = extractProgressId(filePath);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // UUID in path matches metadata progressId
    const meta = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(id).toBe(meta.progressId);
  });

  it('returns null for non-matching path', () => {
    expect(extractProgressId('/tmp/other-file.txt')).toBeNull();
  });
});

describe('appendFinalResult', () => {
  it('writes completed event with result data', () => {
    const filePath = createProgressFile('test', 'codex_session_create');
    filesToClean.push(filePath);

    appendFinalResult(filePath, 'completed', {
      response: 'Hello world',
      thread_id: 'thread_abc',
      session_name: 'test',
      model: 'gpt-5.3-codex',
      duration_ms: 1234,
    });

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.event).toBe('completed');
    expect(last.response).toBe('Hello world');
    expect(last.thread_id).toBe('thread_abc');
    expect(last.ts).toBeTypeOf('number');
  });

  it('writes error event', () => {
    const filePath = createProgressFile('test', 'codex_session_create');
    filesToClean.push(filePath);

    appendFinalResult(filePath, 'error', { error: 'Codex timed out' });

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.event).toBe('error');
    expect(last.error).toBe('Codex timed out');
  });

  it('does not throw on invalid file path', () => {
    expect(() => appendFinalResult('/nonexistent/path.jsonl', 'error', { error: 'test' })).not.toThrow();
  });
});
