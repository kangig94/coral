import { describe, expect, it } from 'vitest';

import { RecoveryQuarantineClearError } from '#src/recovery/source-registry.js';
import { buildTransportErrorResponse } from '#src/transport/error-response.js';

describe('transport error response', () => {
  it.each([
    [
      'boundary-not-registered',
      'recovery_quarantine_boundary_not_registered',
      'That recovery boundary is not available for operator retry.',
    ],
    [
      'subject-not-found',
      'recovery_quarantine_subject_not_found',
      'That recovery quarantine key does not name a retained row.',
    ],
    [
      'revision-mismatch',
      'recovery_quarantine_revision_changed',
      'That recovery quarantine coordinate is stale because its revision changed.',
    ],
    [
      'continuation-not-active',
      'recovery_quarantine_continuation_pending',
      'That recovery quarantine row is a durable continuation and cannot be cleared directly.',
    ],
    [
      'retry-in-progress',
      'recovery_quarantine_retry_in_progress',
      'A recovery retry is already in progress for that quarantine row.',
    ],
  ] as const)('serializes %s as the authored operator error %s', (clearCode, publicCode, userMessage) => {
    const response = buildTransportErrorResponse(new RecoveryQuarantineClearError(clearCode, 'private detail'));

    expect(response).toMatchObject({
      message: userMessage,
      statusCode: 409,
      data: {
        code: publicCode,
        userMessage,
        remediation: expect.stringContaining('recovery-quarantine'),
      },
      body: {
        code: publicCode,
        message: userMessage,
        userMessage,
        remediation: expect.stringContaining('recovery-quarantine'),
      },
    });
    expect(JSON.stringify(response)).not.toContain('private detail');
  });

  it('keeps invalid retry reports on the generic internal-error path', () => {
    expect(
      buildTransportErrorResponse(new RecoveryQuarantineClearError('invalid-retry-report', 'private invariant')),
    ).toEqual({
      message: 'Internal error',
      statusCode: 500,
      body: { code: 'internal_error', message: 'Internal error' },
    });
  });
});
