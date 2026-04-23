import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { BackendToolHttpError } from '../../transport/http/client-errors.js';
import { BackendUnreachableError, TransientHttpError } from '../../shared/utils.js';
import { UsageError, buildErrorEnvelope, errorCodeToExit } from '../errors.js';

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
          detail,
        }),
      );

      expect(result).toEqual({
        envelope: {
          error: true,
          code: 'invalid_request',
          message: 'timeoutSeconds: Number must be less than or equal to 1200',
          detail,
        },
        exitCode: 1,
      });
    });

    it('maps UsageError to invalid_usage and exit 2', () => {
      expect(buildErrorEnvelope(new UsageError('--jobs must include at least one job ID'))).toEqual({
        envelope: {
          error: true,
          code: 'invalid_usage',
          message: '--jobs must include at least one job ID',
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
