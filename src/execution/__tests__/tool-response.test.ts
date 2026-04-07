import { describe, expect, it } from 'vitest';

import type { LaunchDecision } from '../../shared/types.js';
import {
  deriveLegacyErrorMessage,
  domainError,
  domainSuccess,
  domainToHttp,
  launchDecisionToDomain,
} from '../tool-response.js';

describe('tool response domain helpers', () => {
  it('creates success domain results and preserves them in HTTP responses', () => {
    const result = domainSuccess({ session: 'session-1' });

    expect(result).toEqual({ ok: true, data: { session: 'session-1' } });
    expect(domainToHttp(result)).toEqual({
      statusCode: 200,
      body: { ok: true, data: { session: 'session-1' } },
    });
  });

  it('creates error domain results and omits detail when undefined', () => {
    expect(domainError('invalid_request', 'Missing prompt')).toEqual({
      ok: false,
      code: 'invalid_request',
      message: 'Missing prompt',
    });

    expect(domainError('invalid_request', 'Missing prompt', { field: 'prompt' })).toEqual({
      ok: false,
      code: 'invalid_request',
      message: 'Missing prompt',
      detail: { field: 'prompt' },
    });
  });

  it('derives a legacy message from detail.message when present', () => {
    expect(deriveLegacyErrorMessage('kb_error', { message: 'KB failed' })).toBe('KB failed');
    expect(deriveLegacyErrorMessage('kb_error', 'KB failed')).toBe('KB failed');
    expect(deriveLegacyErrorMessage('kb_error', new Error('KB failed'))).toBe('KB failed');
  });

  it('falls back to a humanized code when legacy detail has no message', () => {
    expect(deriveLegacyErrorMessage('pool_too_large', { hint: 'shrink the pool' })).toBe('pool too large');
    expect(deriveLegacyErrorMessage('session_not_found')).toBe('session not found');
  });

  it('maps running and queued launch decisions to success domain results', () => {
    const running = {
      status: 'running',
      job: 'job-1',
      session: 'session-1',
    } satisfies LaunchDecision;
    const queued = {
      status: 'queued',
      job: 'job-2',
      session: 'session-2',
    } satisfies LaunchDecision;

    expect(launchDecisionToDomain(running)).toEqual({ ok: true, data: running });
    expect(launchDecisionToDomain(queued)).toEqual({ ok: true, data: queued });
  });

  it('maps rejected launch decisions to domain errors', () => {
    const rejected = {
      status: 'rejected',
      phase: 'preflight',
      code: 'invalid_request',
      message: 'Missing prompt',
    } satisfies LaunchDecision;

    expect(launchDecisionToDomain(rejected)).toEqual({
      ok: false,
      code: 'invalid_request',
      message: 'Missing prompt',
    });
  });
});
