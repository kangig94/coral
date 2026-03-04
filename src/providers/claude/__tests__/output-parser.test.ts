import { describe, it, expect } from 'vitest';
import { parseClaudeStreamJson } from '../output-parser.js';

function ndjson(...events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

const parseFailureSentinel = {
  response: '',
  sessionId: null,
  model: null,
  costUsd: 0,
  durationMs: null,
  numTurns: null,
  isError: true,
};

function parse(output: string) {
  return parseClaudeStreamJson(output);
}

function expectSuccess(output: string) {
  const result = parse(output);
  expect(result.isError).toBe(false);
  return result;
}

function expectParseFailure(output: string) {
  expect(parse(output)).toEqual(parseFailureSentinel);
}

describe('parseClaudeStreamJson', () => {
  it('extracts response/session/cost/model/duration from NDJSON result + assistant events', () => {
    const output = [
      '{\"type\":\"assistant\",\"message\":{\"model\":\"claude-3-7-sonnet\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}',
      '{\"type\":\"result\",\"result\":\"final answer\",\"session_id\":\"sess-123\",\"total_cost_usd\":0.12,\"duration_ms\":4200,\"num_turns\":2,\"is_error\":false}',
    ].join('\n');

    const parsed = parse(output);

    expect(parsed).toEqual({
      response: 'final answer',
      sessionId: 'sess-123',
      model: 'claude-3-7-sonnet',
      costUsd: 0.12,
      durationMs: 4200,
      numTurns: 2,
      isError: false,
    });
  });

  it('falls back to assistant text when result response is missing', () => {
    const output = [
      '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"part-1 \"},{\"type\":\"text\",\"text\":\"part-2\"}]}}',
      '{\"type\":\"result\",\"session_id\":\"sess-fallback\",\"total_cost_usd\":0.02}',
    ].join('\n');

    const parsed = parse(output);

    expect(parsed.response).toBe('part-1 part-2');
    expect(parsed.sessionId).toBe('sess-fallback');
    expect(parsed.costUsd).toBe(0.02);
    expect(parsed.isError).toBe(false);
  });

  it('ignores malformed lines when at least one valid NDJSON line exists', () => {
    const output = [
      'not-json',
      '{\"type\":\"assistant\",\"message\":{\"model\":\"claude-3-7-sonnet\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}',
      'still-not-json',
      '{\"type\":\"result\",\"result\":\"done\"}',
    ].join('\n');

    const parsed = parse(output);

    expect(parsed.response).toBe('done');
    expect(parsed.model).toBe('claude-3-7-sonnet');
    expect(parsed.isError).toBe(false);
  });

  it('supports legacy single JSON output fallback', () => {
    const output = JSON.stringify({
      type: 'result',
      result: {
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
      },
      session_id: 'legacy-session',
      total_cost_usd: 0.03,
      model: 'legacy-model',
    });

    const parsed = parse(output);

    expect(parsed).toEqual({
      response: 'line one\nline two',
      sessionId: 'legacy-session',
      model: 'legacy-model',
      costUsd: 0.03,
      durationMs: null,
      numTurns: null,
      isError: false,
    });
  });

  it('returns parse-failure sentinel for fully unparseable output', () => {
    expectParseFailure('garbage-output');
  });

  it('returns parse-failure sentinel for empty output', () => {
    expectParseFailure('');
  });
});

describe('parseClaudeStreamJson — adversarial', () => {
  describe('stream with only system/init events — no result, no assistant', () => {
    it('returns sentinel when stream has only a system init event', () => {
      const output = ndjson(
        { type: 'system', subtype: 'init', session_id: 'sess-x', tools: [], mcp_servers: [] },
      );
      expectParseFailure(output);
    });

    it('returns sentinel when stream has system + rate_limit_event but no result', () => {
      const output = ndjson(
        { type: 'system', subtype: 'init', session_id: 'sess-y' },
        { type: 'rate_limit_event', delta_ms: 5000 },
      );
      expectParseFailure(output);
    });
  });

  describe('mixed valid+invalid lines — ordering matters', () => {
    it('tolerates leading garbage line before a valid result event', () => {
      const output = [
        'not valid json at all',
        JSON.stringify({
          type: 'result',
          result: 'hello from result',
          session_id: 'sess-good',
          total_cost_usd: 0.01,
        }),
      ].join('\n') + '\n';

      const result = expectSuccess(output);
      expect(result.response).toBe('hello from result');
      expect(result.sessionId).toBe('sess-good');
    });

    it('tolerates trailing garbage after a valid result event', () => {
      const output = [
        JSON.stringify({ type: 'result', result: 'ok', session_id: 's1', total_cost_usd: 0.005 }),
        '{{broken',
        'also bad',
      ].join('\n') + '\n';

      const result = expectSuccess(output);
      expect(result.response).toBe('ok');
    });

    it('tolerates interleaved garbage between assistant and result events', () => {
      const output = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
        'GARBAGE LINE',
        JSON.stringify({ type: 'result', result: 'final answer', session_id: 's2', total_cost_usd: 0.02 }),
      ].join('\n') + '\n';

      const result = expectSuccess(output);
      expect(result.response).toBe('final answer');
    });
  });

  describe('is_error=true in result event', () => {
    it('sets isError=true when result event carries is_error=true', () => {
      const output = ndjson({
        type: 'result',
        result: 'Error: something went wrong',
        session_id: 'sess-err',
        is_error: true,
        total_cost_usd: 0,
      });
      const result = parse(output);
      expect(result.isError).toBe(true);
    });

    it('preserves response text even when is_error=true (non-empty result)', () => {
      const output = ndjson({
        type: 'result',
        result: 'partial error response',
        session_id: 'sess-partial',
        is_error: true,
        total_cost_usd: 0,
      });
      const result = parse(output);
      expect(result.response).toBe('partial error response');
      expect(result.isError).toBe(true);
    });

    it('sentinel contract: is_error=true AND empty response triggers executor parse-error path', () => {
      const output = ndjson({
        type: 'result',
        result: '',
        session_id: null,
        is_error: true,
        total_cost_usd: 0,
      });
      const result = parse(output);
      expect(result.response).toBe('');
      expect(result.isError).toBe(true);
    });
  });

  describe('result event with null/missing result field — fallback to assistant text', () => {
    it('falls back to accumulated assistant text when result field is null', () => {
      const output = ndjson(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'fallback text' }] } },
        { type: 'result', result: null, session_id: 'sess-null', total_cost_usd: 0.003, is_error: false },
      );
      const result = parse(output);
      expect(result.response).toBe('fallback text');
      expect(result.sessionId).toBe('sess-null');
      expect(result.isError).toBe(false);
    });

    it('falls back to accumulated assistant text when result field is absent entirely', () => {
      const output = ndjson(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'assistant fallback' }] } },
        { type: 'result', session_id: 'sess-missing', total_cost_usd: 0.001 },
      );
      const result = parse(output);
      expect(result.response).toBe('assistant fallback');
      expect(result.sessionId).toBe('sess-missing');
    });

    it('returns sentinel when result is null AND no assistant text accumulated', () => {
      const output = ndjson({
        type: 'result',
        result: null,
        session_id: null,
        is_error: true,
        total_cost_usd: 0,
      });
      const result = parse(output);
      expect(result.response).toBe('');
      expect(result.isError).toBe(true);
    });
  });

  describe('result event where result field is an object (nested content array)', () => {
    it('extracts text from nested content array in result field', () => {
      const output = ndjson({
        type: 'result',
        result: {
          content: [
            { type: 'text', text: 'nested line 1' },
            { type: 'text', text: 'nested line 2' },
          ],
        },
        session_id: 'sess-nested',
        total_cost_usd: 0.01,
      });
      const result = parse(output);
      expect(result.response).not.toBe('');
      expect(result.sessionId).toBe('sess-nested');
    });
  });

  describe('whitespace-only and blank lines between valid NDJSON', () => {
    it('skips blank lines between valid events', () => {
      const output = [
        JSON.stringify({ type: 'result', result: 'clean', session_id: 's3', total_cost_usd: 0.002 }),
        '',
        '   ',
        '',
      ].join('\n');
      const result = expectSuccess(output);
      expect(result.response).toBe('clean');
    });
  });

  describe('multiple assistant text events — accumulation order', () => {
    it('preserves ordering of multiple assistant text blocks in fallback accumulation', () => {
      const output = ndjson(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'third' }] } },
      );
      const result = parse(output);
      const idx1 = result.response.indexOf('first');
      const idx2 = result.response.indexOf('second');
      const idx3 = result.response.indexOf('third');
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx2).toBeGreaterThan(idx1);
      expect(idx3).toBeGreaterThan(idx2);
    });
  });

  describe('num_turns and durationMs mapping', () => {
    it('maps num_turns from result event', () => {
      const output = ndjson({
        type: 'result',
        result: 'answer',
        session_id: 'sess-turns',
        total_cost_usd: 0.01,
        num_turns: 7,
        duration_ms: 1234,
      });
      const result = parse(output);
      expect(result.numTurns).toBe(7);
      expect(result.durationMs).toBe(1234);
    });

    it('returns null for numTurns and durationMs when absent from result event', () => {
      const output = ndjson({
        type: 'result',
        result: 'answer',
        session_id: 'sess-no-meta',
        total_cost_usd: 0.01,
      });
      const result = parse(output);
      expect(result.numTurns).toBeNull();
      expect(result.durationMs).toBeNull();
    });
  });

  describe('costUsd defaults', () => {
    it('returns costUsd=0 when total_cost_usd is absent from result event', () => {
      const output = ndjson({
        type: 'result',
        result: 'answer',
        session_id: 'sess-nocost',
      });
      const result = parse(output);
      expect(result.costUsd).toBe(0);
    });

    it('returns costUsd=0 when total_cost_usd is not a number', () => {
      const output = ndjson({
        type: 'result',
        result: 'answer',
        session_id: 'sess-nancost',
        total_cost_usd: 'free',
      });
      const result = parse(output);
      expect(result.costUsd).toBe(0);
    });
  });

  describe('model extraction', () => {
    it('extracts model from assistant message field', () => {
      const output = ndjson(
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-3-5-sonnet-20241022',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
        { type: 'result', result: 'hi', session_id: 's-model', total_cost_usd: 0 },
      );
      const result = parse(output);
      expect(result.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('returns null model when no model field present anywhere in stream', () => {
      const output = ndjson({
        type: 'result',
        result: 'answer',
        session_id: 'sess-nomodel',
        total_cost_usd: 0,
      });
      const result = parse(output);
      expect(result.model).toBeNull();
    });
  });

  describe('single-JSON fallback path — backward compat', () => {
    it('parses single JSON where result is a plain string', () => {
      const singleJson = JSON.stringify({
        type: 'result',
        result: 'single-json-response',
        session_id: 'sess-single',
        total_cost_usd: 0.007,
      });
      const result = parse(singleJson);
      expect(result.response).toBe('single-json-response');
      expect(result.sessionId).toBe('sess-single');
      expect(result.isError).toBe(false);
    });

    it('single JSON with nested result.response field extracts the inner string', () => {
      const singleJson = JSON.stringify({
        result: { response: 'nested response string' },
        session_id: 'sess-nested-res',
      });
      const result = parse(singleJson);
      expect(result.response).toBe('nested response string');
    });
  });

  describe('fully unparseable output', () => {
    it('returns sentinel for completely non-JSON output (all garbage)', () => {
      const output = 'error: claude not found\nusage: claude [options]\n';
      expectParseFailure(output);
    });

    it('returns sentinel for truly empty string', () => {
      expectParseFailure('');
    });
  });
});
