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
} from '../control-protocol.js';

const sessionId = 'session-1';

function parse(line: Record<string, unknown>) {
  return parseClaudeStdoutLine(JSON.stringify(line));
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

  it('returns null for malformed lines', () => {
    expect(parseClaudeStdoutLine('')).toBeNull();
    expect(parseClaudeStdoutLine('not json')).toBeNull();
    expect(parseClaudeStdoutLine('{"type":"result"')).toBeNull();
    expect(parseClaudeStdoutLine('[]')).toBeNull();
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
