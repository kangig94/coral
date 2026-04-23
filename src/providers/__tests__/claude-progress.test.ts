import { describe, it, expect } from 'vitest';
import { formatToolProgress } from '../../infra/format-progress.js';
import { extractClaudeProgressMessage } from '../claude/progress.js';
import type { ClaudeStreamEvent } from '../claude/types.js';

function assistantEvent(contentBlocks: Array<{ type: string; [key: string]: unknown }>): ClaudeStreamEvent {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: contentBlocks,
    },
  };
}

function toolUseBlock(
  name: string,
  input: Record<string, unknown> = {},
): { type: 'tool_use'; name: string; id: string; input: Record<string, unknown> } {
  return { type: 'tool_use', name, id: 'tu-1', input };
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

function assistantToolEvent(name: string, input: Record<string, unknown> = {}): ClaudeStreamEvent {
  return assistantEvent([toolUseBlock(name, input)]);
}

function expectNullMessage(event: ClaudeStreamEvent, projectRoot?: string): void {
  expect(extractClaudeProgressMessage(event, projectRoot)).toBeNull();
}

describe('extractClaudeProgressMessage', () => {
  it('extracts valid tool_use blocks and delegates formatting with projectRoot', () => {
    const input = { file_path: '/repo/src/main.ts', offset: 10, limit: 20 };
    const event = assistantToolEvent('Read', input);

    expect(extractClaudeProgressMessage(event, '/repo')).toBe(formatToolProgress('Read', input, '/repo'));
  });

  it('returns generating message for assistant text blocks', () => {
    const event = assistantEvent([textBlock('drafting response')]);

    expect(extractClaudeProgressMessage(event)).toBe('Generating response...');
  });

  it('returns null for non-assistant events', () => {
    const event: ClaudeStreamEvent = { type: 'result', result: 'done' };
    expectNullMessage(event);
  });

  it('returns null when assistant content has no text/tool_use blocks', () => {
    expectNullMessage(assistantEvent([{ type: 'tool_result', text: 'ignored' }]));
  });
});

describe('extractClaudeProgressMessage — adversarial', () => {
  describe('multiple content blocks', () => {
    it('returns message for first block when both are tool_use', () => {
      const event = assistantEvent([
        toolUseBlock('Read', { file_path: 'first.ts' }),
        toolUseBlock('Edit', { file_path: 'second.ts', old_string: 'x', new_string: 'y' }),
      ]);
      expect(extractClaudeProgressMessage(event)).toBe(formatToolProgress('Read', { file_path: 'first.ts' }));
    });

    it('returns generating message when a text block appears first', () => {
      const event = assistantEvent([
        textBlock('I will now read the file.'),
        toolUseBlock('Read', { file_path: 'target.ts' }),
      ]);
      expect(extractClaudeProgressMessage(event)).toBe('Generating response...');
    });

    it('returns tool_use message when text block comes AFTER tool_use in same event', () => {
      const input = { command: 'ls -la', description: 'List files' };
      const event = assistantEvent([
        toolUseBlock('Bash', input),
        textBlock('Listing directory contents...'),
      ]);
      expect(extractClaudeProgressMessage(event)).toBe(formatToolProgress('Bash', input));
    });
  });

  describe('tool_use block with missing or invalid name', () => {
    it('handles tool_use block where name is undefined (malformed stream)', () => {
      const event: ClaudeStreamEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-x', input: { file_path: 'f.ts' } }],
        },
      };
      expectNullMessage(event);
    });

    it('handles tool_use block where name is empty string', () => {
      const event = assistantEvent([toolUseBlock('', { file_path: 'f.ts' })]);
      expectNullMessage(event);
    });
  });

  describe('tool_use block with missing or non-object input', () => {
    it('handles tool_use block where input is undefined', () => {
      const event: ClaudeStreamEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', id: 'tu-2' }],
        },
      };
      expectNullMessage(event);
    });

    it('handles tool_use block where input is a string (malformed)', () => {
      const event: ClaudeStreamEvent = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', id: 'tu-3', input: 'bad-input' as unknown as Record<string, unknown> },
          ],
        },
      };
      expectNullMessage(event);
    });

    it('handles tool_use block where input is null', () => {
      const event: ClaudeStreamEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', id: 'tu-4', input: null as unknown as Record<string, unknown> }],
        },
      };
      expectNullMessage(event);
    });
  });

  describe('assistant event with empty content array', () => {
    it('returns null for assistant event with empty content array', () => {
      const event = assistantEvent([]);
      expectNullMessage(event);
    });
  });

  describe('assistant event with no message field', () => {
    it('returns null for assistant event with no message field', () => {
      const event: ClaudeStreamEvent = { type: 'assistant' };
      expectNullMessage(event);
    });

    it('returns null for assistant event where message has no content field', () => {
      const event: ClaudeStreamEvent = {
        type: 'assistant',
        message: { role: 'assistant' },
      };
      expectNullMessage(event);
    });
  });

  describe('content block types that are neither text nor tool_use', () => {
    it('returns null for assistant event with only image block', () => {
      const event: ClaudeStreamEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
        },
      };
      expectNullMessage(event);
    });

    it('returns null for assistant event with only tool_result block', () => {
      const event: ClaudeStreamEvent = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
        },
      };
      expectNullMessage(event);
    });
  });

  describe('user event (tool_result) must return null', () => {
    it('returns null for user-role event', () => {
      const event: ClaudeStreamEvent = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents' }],
        },
      };
      expectNullMessage(event);
    });
  });

  describe('non-assistant event types', () => {
    it('returns null for result event type', () => {
      const event: ClaudeStreamEvent = {
        type: 'result',
        result: 'done',
        session_id: 'sess-1',
      };
      expectNullMessage(event);
    });

    it('returns null for system event type', () => {
      const event: ClaudeStreamEvent = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
      };
      expectNullMessage(event);
    });

    it('returns null for rate_limit_event type', () => {
      const event: ClaudeStreamEvent = {
        type: 'rate_limit_event',
        delta_ms: 5000,
      };
      expectNullMessage(event);
    });
  });
});
