import { describe, it, expect } from 'vitest';
import { parseCodexJsonl } from '../output-parser.js';

describe('parseCodexJsonl', () => {
  it('extracts thread_id from thread.started event', () => {
    const output = '{"type":"thread.started","thread_id":"abc-123"}\n';
    const result = parseCodexJsonl(output);
    expect(result.threadId).toBe('abc-123');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('extracts text from item.completed with agent_message', () => {
    const output = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello world"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Hello world');
    expect(result.threadId).toBe('t1');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('extracts error from turn.failed event', () => {
    const output = '{"type":"turn.failed","error":{"message":"Rate limit exceeded"}}\n';
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Rate limit exceeded']);
  });

  it('extracts error from top-level error event', () => {
    const output = '{"type":"error","message":"Connection lost"}\n';
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Connection lost']);
  });

  it('returns empty response for empty output', () => {
    const result = parseCodexJsonl('');
    expect(result.response).toBe('');
    expect(result.threadId).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('skips non-JSON lines', () => {
    const output = [
      'Some debug output',
      '{"type":"thread.started","thread_id":"t1"}',
      'More debug',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('OK');
    expect(result.threadId).toBe('t1');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('returns null threadId when no thread.started event', () => {
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hi"}}\n';
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Hi');
    expect(result.threadId).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('handles composite output with multiple agent_messages', () => {
    const output = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Part 1"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Part 2"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":20}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Part 1\nPart 2');
    expect(result.threadId).toBe('t1');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('ignores non-agent_message item types', () => {
    const output = [
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"file.txt","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Done"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Done');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('handles item.completed with empty text', () => {
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":""}}\n';
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('extracts warning from item.completed with error type', () => {
    const output = [
      '{"type":"item.completed","item":{"id":"w1","type":"error","message":"Deprecated API usage"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Done"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Done');
    expect(result.warnings).toEqual(['Deprecated API usage']);
    expect(result.errors).toEqual([]);
  });

  it('deduplicates error + turn.failed with same message', () => {
    const output = [
      '{"type":"error","message":"Rate limit exceeded"}',
      '{"type":"turn.failed","error":{"message":"Rate limit exceeded"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Rate limit exceeded']);
  });

  it('preserves distinct turn.failed message', () => {
    const output = [
      '{"type":"error","message":"Connection error"}',
      '{"type":"turn.failed","error":{"message":"Turn failed due to connection error"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Connection error', 'Turn failed due to connection error']);
  });

  it('handles error event with exit code 0 (StreamError scenario)', () => {
    const output = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"error","message":"Stream interrupted"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Partial result"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Partial result');
    expect(result.errors).toEqual(['Stream interrupted']);
    expect(result.warnings).toEqual([]);
    expect(result.threadId).toBe('t1');
  });

  it('handles mixed error, warning, and turn.failed correctly', () => {
    const output = [
      '{"type":"error","message":"Rate limit"}',
      '{"type":"item.completed","item":{"id":"w1","type":"error","message":"Deprecated API"}}',
      '{"type":"turn.failed","error":{"message":"Rate limit"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Rate limit']);
    expect(result.warnings).toEqual(['Deprecated API']);
  });

  it('does not confuse [Error] in agent_message with actual errors', () => {
    const output = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"[Error] Use the Error class to design your errors."}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":20}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('[Error] Use the Error class to design your errors.');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('separates partial response from rate limit error', () => {
    const output = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Analysis results..."}}',
      '{"type":"error","message":"Rate limit exceeded"}',
      '{"type":"turn.failed","error":{"message":"Rate limit exceeded"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Analysis results...');
    expect(result.errors).toEqual(['Rate limit exceeded']);
    expect(result.warnings).toEqual([]);
  });

  it('handles error + warning + partial response', () => {
    const output = [
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Partial result"}}',
      '{"type":"item.completed","item":{"id":"w1","type":"error","message":"Deprecated"}}',
      '{"type":"error","message":"Rate limit"}',
      '{"type":"turn.failed","error":{"message":"Rate limit"}}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('Partial result');
    expect(result.errors).toEqual(['Rate limit']);
    expect(result.warnings).toEqual(['Deprecated']);
  });

  it('collects multiple distinct errors', () => {
    const output = [
      '{"type":"error","message":"Stream error"}',
      '{"type":"error","message":"Rate limit exceeded"}',
    ].join('\n');
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Stream error', 'Rate limit exceeded']);
    expect(result.warnings).toEqual([]);
  });

  it('handles warning-only with no response', () => {
    const output = '{"type":"item.completed","item":{"id":"w1","type":"error","message":"Deprecated API usage"}}\n';
    const result = parseCodexJsonl(output);
    expect(result.response).toBe('');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['Deprecated API usage']);
  });
});
