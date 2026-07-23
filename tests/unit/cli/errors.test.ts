import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { BackendToolHttpError } from '#src/transport/http/errors.js';
import { BackendUnreachableError, TransientHttpError } from '#src/infra/http-errors.js';
import { StoreResetCliError, UsageError, buildErrorEnvelope, errorCodeToExit } from '#src/cli/errors.js';

describe('cli errors', () => {
  describe('buildErrorEnvelope', () => {
    it('lifts BackendToolHttpError bodies into the flat cli envelope', () => {
      const detail = {
        issues: [{ code: 'too_big', path: ['timeoutSeconds'], message: 'Number must be less than or equal to 1200' }],
      };
      const result = buildErrorEnvelope(
        new BackendToolHttpError('timeout failed', 400, {
          code: 'invalid_request',
          message: 'timeoutSeconds: Number must be less than or equal to 1200',
          remediation: 'Retry with timeoutSeconds <= 1200.',
          detail,
        }),
      );

      expect(result).toEqual({
        envelope: {
          error: true,
          code: 'invalid_request',
          message: 'timeoutSeconds: Number must be less than or equal to 1200',
          remediation: 'Retry with timeoutSeconds <= 1200.',
          detail,
        },
        exitCode: 1,
      });
    });

    it('maps UsageError to invalid_usage and exit 2', () => {
      expect(buildErrorEnvelope(new UsageError('jobs must include at least one job ID'))).toEqual({
        envelope: {
          error: true,
          code: 'invalid_usage',
          message: 'jobs must include at least one job ID',
        },
        exitCode: 2,
      });
    });

    it('maps CommanderError to invalid_usage and exit 2', () => {
      expect(buildErrorEnvelope(new CommanderError(2, 'commander.invalidOptionArgument', 'bad flag'))).toEqual({
        envelope: {
          error: true,
          code: 'invalid_usage',
          message: 'bad flag',
        },
        exitCode: 2,
      });
    });

    it('maps TransientHttpError to transient and exit 75', () => {
      expect(buildErrorEnvelope(new TransientHttpError(503, 'Backend shutting down'))).toEqual({
        envelope: {
          error: true,
          code: 'transient',
          message: 'Backend shutting down',
        },
        exitCode: 75,
      });
    });

    it('maps BackendUnreachableError to backend_unreachable and exit 69', () => {
      expect(buildErrorEnvelope(new BackendUnreachableError('fetch failed'))).toEqual({
        envelope: {
          error: true,
          code: 'backend_unreachable',
          message: 'fetch failed',
        },
        exitCode: 69,
      });
    });

    it('maps generic Error to internal and exit 70', () => {
      expect(buildErrorEnvelope(new Error('boom'))).toEqual({
        envelope: {
          error: true,
          code: 'internal',
          message: 'boom',
        },
        exitCode: 70,
      });
    });

    it.each([
      [
        'invalid_store_reset_incident_id',
        'Incident ID must be a canonical lowercase UUID.',
        'Run `coral-cli backend store-reset list` and use the ID of an incident in the `ready` state.',
        2,
      ],
      [
        'store_reset_incident_not_found',
        'Store-reset incident not found.',
        'Run `coral-cli backend store-reset list`. If no incident is retained, file a Store-reset incident issue with this complete fixed error output; do not attach DB, WAL, SHM, or raw logs.',
        1,
      ],
      [
        'store_reset_incident_limit_exceeded',
        'Too many retained store-reset entries to list safely; report a known incident ID directly.',
        'Use an incident ID from the reset warning. If none is available, file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.',
        1,
      ],
      [
        'store_reset_build_mismatch',
        'Store-reset reporting is unavailable because the installed build artifacts do not match.',
        'Reinstall or update Coral through the same install method without deleting Coral data, then retry. If it persists, file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.',
        70,
      ],
      [
        'store_reset_incident_build_mismatch',
        'The retained incident belongs to a different Coral build set and cannot be reported by this build.',
        'Keep the incident in place and file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.',
        70,
      ],
      [
        'store_reset_reporting_failed',
        'Store-reset reporting failed.',
        'Retry once. If it still fails, file a Store-reset incident issue with this fixed error output; do not move, restore, delete, or attach DB, WAL, SHM, or raw logs.',
        70,
      ],
    ] as const)(
      'maps the closed store-reset error %s without private detail',
      (code, message, remediation, exitCode) => {
        expect(buildErrorEnvelope(new StoreResetCliError(code))).toEqual({
          envelope: {
            error: true,
            code,
            message,
            remediation,
          },
          exitCode,
        });
      },
    );

    it.each([
      [{ code: 'backend_shutting_down', message: 'Backend shutting down' }, 503, 75],
      [{ code: 'internal_error', message: 'Internal error' }, 500, 70],
      [{ code: 'unauthorized', message: 'Unauthorized' }, 401, 1],
      [{ code: 'backend_error', message: 'Retry later' }, 503, 75],
      [{ code: 'backend_error', message: 'Server exploded' }, 500, 70],
      [{ code: 'not_found', message: 'Not found' }, 404, 1],
    ])('uses backend code/status combinations %j / %i -> %i', (body, statusCode, exitCode) => {
      expect(buildErrorEnvelope(new BackendToolHttpError(body.message, statusCode, body)).exitCode).toBe(exitCode);
    });
  });

  describe('errorCodeToExit', () => {
    it.each([
      ['invalid_usage', undefined, 2],
      ['transient', undefined, 75],
      ['backend_shutting_down', undefined, 75],
      ['backend_error', 503, 75],
      ['backend_unreachable', undefined, 69],
      ['internal', undefined, 70],
      ['internal_error', undefined, 70],
      ['backend_error', 500, 70],
      ['unauthorized', 401, 1],
      ['session_not_found', 404, 1],
      ['not_found', 404, 1],
      ['audit_requires_ended_session', 409, 1],
      ['invalid_request', 400, 1],
      ['backend_recovering', 503, 75],
      ['unexpected_code', undefined, 1],
    ])('maps %s / %s to %i', (code, httpStatus, exitCode) => {
      expect(errorCodeToExit(code, httpStatus)).toBe(exitCode);
    });
  });
});
