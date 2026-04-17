import { describe, it, expect } from 'vitest';
import { mapTurnStartParams } from '../codex/request-mapping.js';
import type { ProviderRequest } from '../../shared/types.js';

describe('mapTurnStartParams effort mapping', () => {
  function makeRequest(effort: ProviderRequest['effort']): ProviderRequest {
    return {
      action: 'exec',
      sessionId: 's-1',
      prompt: 'test',
      cwd: '/tmp',
      effort,
      bypassPermissions: false,
      coralEnv: {},
    };
  }

  const VALID_CODEX_EFFORT = new Set(['low', 'medium', 'high', 'xhigh']);

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'xhigh'],
  ] as const)('maps Coral effort %s to Codex %s', (coral, codex) => {
    const params = mapTurnStartParams(makeRequest(coral), 'thread-1');
    expect(params.effort).toBe(codex);
  });

  it.each(['low', 'medium', 'high', 'max'] as const)('Coral %s produces a valid Codex effort value', (coral) => {
    const params = mapTurnStartParams(makeRequest(coral), 'thread-1');
    expect(VALID_CODEX_EFFORT.has(params.effort as string)).toBe(true);
  });
});
