import { describe, it, expect } from 'vitest';
import { resultToMcp, endContent, nowIsoString, resolveSession } from '../handlers/utils.js';
import type { Result } from '../types.js';

describe('resultToMcp', () => {
  it('should return JSON with value fields for ok result', () => {
    const result: Result<{ status: string }> = { ok: true, value: { status: 'bidding' } };
    const mcp = resultToMcp(result);
    expect(mcp.isError).toBe(false);
    const parsed = JSON.parse(mcp.content[0].text) as Record<string, unknown>;
    expect(parsed.status).toBe('bidding');
  });

  it('should return JSON with error field for error result', () => {
    const result: Result<never> = { ok: false, error: 'agent_not_found' };
    const mcp = resultToMcp(result);
    expect(mcp.isError).toBe(false);
    const parsed = JSON.parse(mcp.content[0].text) as Record<string, unknown>;
    expect(parsed.error).toBe('agent_not_found');
  });

  it('should spread detail fields into the response for error result with detail', () => {
    const result: Result<never> = {
      ok: false,
      error: 'invalid_status',
      detail: { current: 'speaking', expected: 'bidding' },
    };
    const mcp = resultToMcp(result);
    const parsed = JSON.parse(mcp.content[0].text) as Record<string, unknown>;
    expect(parsed.error).toBe('invalid_status');
    expect(parsed.current).toBe('speaking');
    expect(parsed.expected).toBe('bidding');
  });

  it('should handle error result with no detail field (detail is optional)', () => {
    const result: Result<never> = { ok: false, error: 'not_bidding' };
    expect(() => resultToMcp(result)).not.toThrow();
    const mcp = resultToMcp(result);
    const parsed = JSON.parse(mcp.content[0].text) as Record<string, unknown>;
    expect(parsed.error).toBe('not_bidding');
  });

  it('should produce content array with exactly one text entry', () => {
    const mcp = resultToMcp({ ok: true, value: { x: 1 } });
    expect(mcp.content).toHaveLength(1);
    expect(mcp.content[0].type).toBe('text');
    expect(typeof mcp.content[0].text).toBe('string');
  });
});

describe('endContent', () => {
  it('should return non-empty string for all_below_threshold', () => {
    expect(endContent('all_below_threshold').length).toBeGreaterThan(0);
  });

  it('should return non-empty string for max_epochs_reached', () => {
    expect(endContent('max_epochs_reached').length).toBeGreaterThan(0);
  });

  it('should return non-empty string for all_blocked', () => {
    expect(endContent('all_blocked').length).toBeGreaterThan(0);
  });

  it('should return non-empty string for no_participants', () => {
    expect(endContent('no_participants').length).toBeGreaterThan(0);
  });

  it('should return distinct strings for each reason', () => {
    const reasons = ['all_below_threshold', 'max_epochs_reached', 'all_blocked', 'no_participants'] as const;
    const messages = reasons.map(endContent);
    const unique = new Set(messages);
    expect(unique.size).toBe(reasons.length);
  });
});

describe('nowIsoString', () => {
  it('should return a valid ISO 8601 string', () => {
    const result = nowIsoString();
    expect(() => new Date(result)).not.toThrow();
    expect(new Date(result).toISOString()).toBe(result);
  });

  it('should return a string close to the current time', () => {
    const before = Date.now();
    const result = nowIsoString();
    const after = Date.now();
    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('returns non-decreasing timestamps on repeated calls (not memoized)', () => {
    const t1 = new Date(nowIsoString()).getTime();
    const t2 = new Date(nowIsoString()).getTime();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});

describe('resolveSession', () => {
  it('should return the error McpResult when session is not found', () => {
    const mockStore = { resolveDir: (_id: string) => null } as unknown as import('../session-store.js').SessionStore;
    const result = resolveSession(mockStore, 'nonexistent-session');
    expect(typeof result).toBe('object');
    expect((result as import('../../shared/mcp-utils.js').McpResult).isError).toBe(true);
  });

  it('should return the sessionDir string when session is found', () => {
    const mockStore = { resolveDir: (_id: string) => '/some/path' } as unknown as import('../session-store.js').SessionStore;
    const result = resolveSession(mockStore, 'valid-session');
    expect(result).toBe('/some/path');
  });
});
