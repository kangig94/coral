import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LaunchDecision } from '#src/jobs/launch.js';
import { deriveErrorMessage, domainError, domainSuccess } from '#src/transport/tool-result.js';
import { domainResultToHttp, launchToHttp } from '#src/transport/response.js';
import { formatZodError } from '#src/transport/validation.js';

describe('tool response domain helpers', () => {
  it('creates success domain results', () => {
    expect(domainSuccess({ session: 'session-1' })).toEqual({
      ok: true,
      data: { session: 'session-1' },
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

  it('derives an error message from detail.message when present', () => {
    expect(deriveErrorMessage('kb_error', { message: 'KB failed' })).toBe('KB failed');
    expect(deriveErrorMessage('kb_error', 'KB failed')).toBe('KB failed');
    expect(deriveErrorMessage('kb_error', new Error('KB failed'))).toBe('KB failed');
  });

  it('falls back to a humanized code when detail has no message', () => {
    expect(deriveErrorMessage('pool_too_large', { hint: 'shrink the pool' })).toBe('pool too large');
    expect(deriveErrorMessage('session_not_found')).toBe('session not found');
  });

  it('formats a single zod issue as a one-line message with detail.issues', () => {
    const parsed = z.object({ timeoutSeconds: z.number().max(1200) }).safeParse({ timeoutSeconds: 1800 });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error('Expected zod parse to fail');
    }

    expect(formatZodError(parsed.error)).toEqual({
      message: 'timeoutSeconds: Number must be less than or equal to 1200',
      detail: {
        issues: parsed.error.issues,
      },
    });
  });

  it('formats multiple zod issues with a (+N more issues) suffix and preserves all issues in detail', () => {
    const parsed = z
      .object({
        timeoutSeconds: z.number().max(1200),
        jobIds: z.array(z.string().min(1)).min(1),
      })
      .safeParse({ timeoutSeconds: 1800, jobIds: [] });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error('Expected zod parse to fail');
    }

    const formatted = formatZodError(parsed.error);
    expect(formatted.message).toBe('timeoutSeconds: Number must be less than or equal to 1200 (+1 more issues)');
    expect(formatted.detail.issues).toHaveLength(parsed.error.issues.length);
    expect(formatted.detail.issues).toEqual(parsed.error.issues);
  });

  it('uses the first issue message directly when the issue path is empty', () => {
    const parsed = z
      .object({
        pattern: z.string().optional(),
        all: z.boolean().optional(),
      })
      .refine((data) => (data.pattern !== undefined) !== (data.all === true), {
        message: 'Exactly one of pattern or all=true must be provided',
      })
      .safeParse({ pattern: '*', all: true });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error('Expected zod parse to fail');
    }

    expect(formatZodError(parsed.error)).toEqual({
      message: 'Exactly one of pattern or all=true must be provided',
      detail: {
        issues: parsed.error.issues,
      },
    });
  });

  it('falls back to "invalid request" when a zod error has no issues', () => {
    const formatted = formatZodError(new z.ZodError([]));
    expect(formatted).toEqual({
      message: 'invalid request',
      detail: {
        issues: [],
      },
    });
  });
});

describe('launchToHttp', () => {
  it('maps running launches to the accepted status code and includes launchState', () => {
    const decision = {
      status: 'running',
      job: 'job-1',
      session: 'session-1',
    } satisfies LaunchDecision;

    expect(launchToHttp(decision, 201)).toEqual({
      statusCode: 201,
      body: {
        session: 'session-1',
        job: 'job-1',
        launchState: 'running',
      },
    });
  });

  it('maps queued launches to the accepted status code and includes launchState', () => {
    const decision = {
      status: 'queued',
      job: 'job-2',
      session: 'session-2',
    } satisfies LaunchDecision;

    expect(launchToHttp(decision, 201)).toEqual({
      statusCode: 201,
      body: {
        session: 'session-2',
        job: 'job-2',
        launchState: 'queued',
      },
    });
  });

  it('uses 202 when the caller passes it for accepted launches', () => {
    const decision = {
      status: 'running',
      job: 'job-3',
      session: 'session-3',
    } satisfies LaunchDecision;

    expect(launchToHttp(decision, 202)).toEqual({
      statusCode: 202,
      body: {
        session: 'session-3',
        job: 'job-3',
        launchState: 'running',
      },
    });
  });

  it('maps provider_mismatch launch rejections to HTTP 409 with the expected error body', () => {
    const decision = {
      status: 'rejected',
      phase: 'preflight',
      code: 'provider_mismatch',
      message: 'Session session-1 belongs to provider codex',
    } satisfies LaunchDecision;

    expect(launchToHttp(decision, 202)).toEqual({
      statusCode: 409,
      body: {
        code: 'provider_mismatch',
        message: 'Session session-1 belongs to provider codex',
      },
    });
  });

  it.each([
    ['invalid_agent', 400],
    ['agent_not_found', 404],
    ['agent_namespace_not_found', 404],
    ['busy', 503],
    ['session_not_found', 404],
    ['preflight_failed', 503],
    ['unknown_provider', 404],
    ['scope_mismatch', 403],
    ['session_busy', 409],
    ['non_resumable', 409],
    ['provider_mismatch', 409],
    ['invalid_request', 400],
    ['provider_credential_source_missing', 400],
  ])('maps rejected launch code %s to HTTP %i', (code, statusCode) => {
    const decision = {
      status: 'rejected',
      phase: 'preflight',
      code,
      message: `Rejected: ${code}`,
    } satisfies LaunchDecision;

    expect(launchToHttp(decision, 201).statusCode).toBe(statusCode);
  });
});

describe('domainResultToHttp', () => {
  it('unwraps successful domain results directly into a 200 response body', () => {
    expect(domainResultToHttp(domainSuccess({ session: 'session-1' }))).toEqual({
      statusCode: 200,
      body: { session: 'session-1' },
    });
  });

  it.each([
    ['invalid_request', 400],
    ['not_found', 404],
    ['session_not_found', 404],
    ['unknown_tool', 404],
    ['scope_mismatch', 403],
    ['backend_recovering', 503],
    ['kb_unavailable', 503],
    ['start_failed', 500],
    ['kb_error', 500],
    ['discuss_error', 500],
    ['unexpected_failure', 500],
  ])('maps domain error code %s to HTTP %i', (code, statusCode) => {
    expect(domainResultToHttp(domainError(code, `Error: ${code}`))).toEqual({
      statusCode,
      body: {
        code,
        message: `Error: ${code}`,
      },
    });
  });

  it('includes detail in error bodies when present', () => {
    expect(domainResultToHttp(domainError('kb_error', 'KB failed', { note: 'broken' }))).toEqual({
      statusCode: 500,
      body: {
        code: 'kb_error',
        message: 'KB failed',
        detail: { note: 'broken' },
      },
    });
  });
});
