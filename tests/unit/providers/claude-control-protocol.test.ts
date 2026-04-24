import { describe, expect, it } from 'vitest';
import {
  claudeControlRequestSubtypes,
  isAssistantMessage,
  isControlRequest,
  isControlResponse,
  isKeepAliveMessage,
  isPermissionRequest,
  isResultMessage,
  isSystemMessage,
  ndjsonSafeStringify,
  parseClaudeStdoutLine,
} from '#src/providers/claude/control-protocol.js';

const sessionId = 'session-1';

function parse(line: Record<string, unknown>) {
  return parseClaudeStdoutLine(JSON.stringify(line));
}

function validAssistantLine(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    },
    parent_tool_use_id: null,
    uuid: 'assistant-1',
    session_id: sessionId,
    ...overrides,
  });
}

function validResultLine(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-1',
    session_id: sessionId,
    ...overrides,
  });
}

describe('ndjsonSafeStringify', () => {
  it('escapes JS line terminators and appends a trailing newline', () => {
    const serialized = ndjsonSafeStringify({
      type: 'user',
      message: {
        role: 'user',
        content: 'alpha\u2028beta\u2029gamma',
      },
    });

    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized).toContain('\\u2028');
    expect(serialized).toContain('\\u2029');
    const lines = serialized.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    expect(JSON.parse(lines[0])).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: 'alpha\u2028beta\u2029gamma',
      },
    });
  });

  describe('output safety', () => {
    it('appends exactly one trailing newline (NDJSON format)', () => {
      const result = ndjsonSafeStringify({ type: 'keep_alive' });

      expect(result.endsWith('\n')).toBe(true);
      expect(result.endsWith('\n\n')).toBe(false);
    });

    it('the JSON payload before the trailing newline does not contain literal newlines', () => {
      const result = ndjsonSafeStringify({ type: 'user', content: 'line one\nline two' });
      const payload = result.slice(0, -1);

      expect(payload).not.toContain('\n');
    });

    it('output is valid JSON (ignoring trailing newline)', () => {
      const result = ndjsonSafeStringify({
        type: 'initialize',
        model: 'claude-opus-4',
        system_prompt: 'be precise\nnewlines here',
      });

      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('produces output that survives a split-by-newline round-trip intact', () => {
      const serialized = ndjsonSafeStringify({
        type: 'user',
        content: 'multi\nline\ncontent\u2028with\u2029separators',
      });

      const lines = serialized.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        type: 'user',
        content: 'multi\nline\ncontent\u2028with\u2029separators',
      });
    });

    it('throws for non-serializable input', () => {
      expect(() => ndjsonSafeStringify(BigInt(42))).toThrow();
    });
  });
});

describe('parseClaudeStdoutLine', () => {
  it('parses supported stdout message families', () => {
    const assistant = parse({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'text', text: 'Working...' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { file_path: '/tmp/example.txt' },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: 'assistant-1',
      session_id: sessionId,
    });

    const result = parse({
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: 'done',
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: { output_tokens: 4 },
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
      },
      permission_denials: [],
      uuid: 'result-1',
      session_id: sessionId,
    });

    const system = parse({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      permissionMode: 'default',
      uuid: 'system-1',
      session_id: sessionId,
    });

    const permissionRequest = parse({
      type: 'control_request',
      request_id: 'request-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'pwd' },
        tool_use_id: 'toolu_1',
      },
    });

    const controlResponse = parse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'request-1',
        response: { behavior: 'allow' },
      },
    });

    const keepAlive = parse({
      type: 'keep_alive',
    });

    expect(assistant).not.toBeNull();
    expect(result).not.toBeNull();
    expect(system).not.toBeNull();
    expect(permissionRequest).not.toBeNull();
    expect(controlResponse).not.toBeNull();
    expect(keepAlive).not.toBeNull();

    expect(isAssistantMessage(assistant)).toBe(true);
    expect(isResultMessage(result)).toBe(true);
    expect(isSystemMessage(system)).toBe(true);
    expect(isControlRequest(permissionRequest)).toBe(true);
    expect(isPermissionRequest(permissionRequest)).toBe(true);
    expect(isControlResponse(controlResponse)).toBe(true);
    expect(isKeepAliveMessage(keepAlive)).toBe(true);
  });

  describe('line boundary correctness via split-then-parse', () => {
    it('U+2028 LINE SEPARATOR inside a JSON string does not break line splitting', () => {
      const raw = `${validAssistantLine({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'line\u2028break' }],
        },
      })}\n${JSON.stringify({ type: 'keep_alive' })}\n`;

      const lines = raw.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);

      const first = parseClaudeStdoutLine(lines[0]);
      const second = parseClaudeStdoutLine(lines[1]);

      expect(first).not.toBeNull();
      expect((first as { type: string }).type).toBe('assistant');
      expect(second).not.toBeNull();
      expect((second as { type: string }).type).toBe('keep_alive');
    });

    it('U+2029 PARAGRAPH SEPARATOR inside a JSON string does not break line splitting', () => {
      const raw = `${validAssistantLine({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'para\u2029break' }],
        },
      })}\n${JSON.stringify({ type: 'keep_alive' })}\n`;

      const lines = raw.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);

      const parsed = parseClaudeStdoutLine(lines[0]);
      expect(parsed).not.toBeNull();
      expect((parsed as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe(
        'para\u2029break',
      );
    });

    it('blank lines between events are harmless (parseClaudeStdoutLine returns null)', () => {
      const raw = `${validAssistantLine()}\n\n\n${JSON.stringify({ type: 'keep_alive' })}\n`;

      const results = raw
        .split('\n')
        .map((line) => parseClaudeStdoutLine(line))
        .filter((result) => result !== null);

      expect(results).toHaveLength(2);
    });

    it('partial JSON line returns null without throwing', () => {
      const raw = `${validAssistantLine()}\n{"type":"result","res`;
      const lines = raw.split('\n').filter((line) => line.length > 0);

      expect(lines).toHaveLength(2);
      expect(parseClaudeStdoutLine(lines[0])).not.toBeNull();
      expect(parseClaudeStdoutLine(lines[1])).toBeNull();
    });
  });

  it('returns null for unsupported but valid Claude stdout messages', () => {
    const streamEvent = parse({
      type: 'stream_event',
      event: { type: 'content_block_delta' },
      parent_tool_use_id: null,
      uuid: 'stream-1',
      session_id: sessionId,
    });

    const postTurnSummary = parse({
      type: 'system',
      subtype: 'post_turn_summary',
      summarizes_uuid: 'assistant-1',
      status_category: 'completed',
      status_detail: 'Finished',
      is_noteworthy: false,
      title: 'Complete',
      description: 'Work finished',
      recent_action: 'Updated the file',
      needs_action: 'None',
      artifact_urls: [],
      uuid: 'summary-1',
      session_id: sessionId,
    });

    const initializeRequestOnStdout = parse({
      type: 'control_request',
      request_id: 'request-2',
      request: {
        subtype: 'initialize',
        systemPrompt: 'Stay concise.',
      },
    });

    expect(streamEvent).toBeNull();
    expect(postTurnSummary).toBeNull();
    expect(initializeRequestOnStdout).toBeNull();
  });

  describe('malformed and edge-case inputs', () => {
    it('returns null for a completely non-JSON line', () => {
      expect(parseClaudeStdoutLine('not json at all')).toBeNull();
    });

    it('returns null for a truncated JSON object', () => {
      expect(parseClaudeStdoutLine('{"type":"result","result":')).toBeNull();
    });

    it('returns null for a JSON array (wrong top-level type)', () => {
      expect(parseClaudeStdoutLine('["type","value"]')).toBeNull();
    });

    it('returns null for a JSON string primitive (not an object)', () => {
      expect(parseClaudeStdoutLine('"just a string"')).toBeNull();
    });

    it('returns null for a JSON number primitive', () => {
      expect(parseClaudeStdoutLine('42')).toBeNull();
    });

    it('parses a valid assistant event', () => {
      const result = parseClaudeStdoutLine(validAssistantLine());

      expect(result).not.toBeNull();
      expect((result as { type: string }).type).toBe('assistant');
    });

    it('returns null for assistant event missing required fields', () => {
      const result = parseClaudeStdoutLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello' }] },
        }),
      );

      expect(result).toBeNull();
    });

    it('parses a valid result event', () => {
      const result = parseClaudeStdoutLine(validResultLine());

      expect(result).not.toBeNull();
      expect((result as { type: string }).type).toBe('result');
    });

    it('returns null for result event missing required fields', () => {
      const result = parseClaudeStdoutLine(
        JSON.stringify({
          type: 'result',
          result: 'done',
          session_id: sessionId,
          total_cost_usd: 0.01,
        }),
      );

      expect(result).toBeNull();
    });

    it('parses a keep_alive event', () => {
      const result = parseClaudeStdoutLine(JSON.stringify({ type: 'keep_alive' }));

      expect(result).not.toBeNull();
      expect((result as { type: string }).type).toBe('keep_alive');
    });

    it('does not throw for an unknown event type (returns null)', () => {
      const line = JSON.stringify({ type: 'some_future_claude_event', payload: {} });

      expect(() => parseClaudeStdoutLine(line)).not.toThrow();
      expect(parseClaudeStdoutLine(line)).toBeNull();
    });

    it('does not throw for control_request with an unknown subtype', () => {
      const line = JSON.stringify({
        type: 'control_request',
        subtype: 'future_unknown_permission_subtype',
        request_id: 'req-99',
      });

      expect(() => parseClaudeStdoutLine(line)).not.toThrow();
    });

    it('handles a null byte embedded in a string value without crashing', () => {
      const line =
        '{"type":"assistant","message":{"content":[{"type":"text","text":"ok\\u0000value"}]},' +
        '"parent_tool_use_id":null,"uuid":"u1","session_id":"s1"}';

      expect(() => parseClaudeStdoutLine(line)).not.toThrow();
      expect(parseClaudeStdoutLine(line)).not.toBeNull();
    });

    it('handles an object with extra unknown fields without crashing', () => {
      const result = parseClaudeStdoutLine(
        validResultLine({
          unknown_future_field: { nested: true },
          another_field: [1, 2, 3],
        }),
      );

      expect(result).not.toBeNull();
      expect((result as { type: string }).type).toBe('result');
      expect((result as Record<string, unknown>).unknown_future_field).toEqual({ nested: true });
    });

    it('returns null for an empty string', () => {
      expect(parseClaudeStdoutLine('')).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(parseClaudeStdoutLine('   \t  ')).toBeNull();
    });

    it('does not throw for control_request with subtype can_use_tool missing request_id', () => {
      const line = JSON.stringify({ type: 'control_request', subtype: 'can_use_tool', tool_name: 'Bash' });

      expect(() => parseClaudeStdoutLine(line)).not.toThrow();
      expect(parseClaudeStdoutLine(line)).toBeNull();
    });

    it('strips trailing \\r (Windows-style line endings)', () => {
      const result = parseClaudeStdoutLine(validAssistantLine() + '\r');

      expect(result).not.toBeNull();
      expect((result as { type: string }).type).toBe('assistant');
    });
  });

  it('exports the expected Claude control request subtype constants', () => {
    expect(claudeControlRequestSubtypes).toEqual({
      initialize: 'initialize',
      interrupt: 'interrupt',
      canUseTool: 'can_use_tool',
      setModel: 'set_model',
      setMaxThinkingTokens: 'set_max_thinking_tokens',
    });
  });
});
