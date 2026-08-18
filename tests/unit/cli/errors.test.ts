import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { BackendToolHttpError } from '#src/transport/http/errors.js';
import { BackendUnreachableError, TransientHttpError } from '#src/infra/http-errors.js';
import { StoreResetCliError, UsageError, buildErrorEnvelope, errorCodeToExit } from '#src/cli/errors.js';
import { documentedCoralSetupError, serializeCoralSetupError } from '#src/runtime/errors.js';
import { buildTransportErrorResponse } from '#src/transport/error-response.js';
import { ChildPrincipalBindingError } from '#src/transport/ipc/child-principal-auth.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';

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

    it('maps incomplete nested credentials to a public remediation without exposing variable names', () => {
      expect(buildErrorEnvelope(new ChildPrincipalBindingError())).toEqual({
        envelope: {
          error: true,
          code: 'child_credentials_incomplete',
          message: 'This nested Coral command has incomplete child credentials and was not sent.',
          remediation:
            'Return to the top-level Coral session and run the command there. Retry the parent workflow instead of editing CORAL_* environment variables.',
        },
        exitCode: 77,
      });
    });

    it('preserves a nested capability denial as authorization instead of internal failure', () => {
      expect(
        buildErrorEnvelope(
          new IpcRpcError({
            code: -32603,
            message: 'This nested Coral session cannot perform this command.',
            data: {
              code: 'missing_capability',
              message: 'This nested Coral session cannot perform this command.',
              detail: { requires: 'sessions:create' },
            },
          }),
        ),
      ).toEqual({
        envelope: {
          error: true,
          code: 'missing_capability',
          message: 'This nested Coral session cannot perform this command.',
          detail: { requires: 'sessions:create' },
        },
        exitCode: 77,
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

    it('drops documented setup-error context from the CLI envelope', () => {
      const error = documentedCoralSetupError('store_reset_interrupted_foreign', {
        flavor: 'prod',
        cause: 'raw filesystem failure that must stay private',
      });

      expect(buildErrorEnvelope(error).envelope).toEqual({
        error: true,
        code: 'store_reset_interrupted_foreign',
        message: 'Coral found an unrecognized entry in the interrupted backend store-reset staging area.',
        remediation:
          "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to resume the interrupted reset under explicit operator control. Startup leaves the active store and staged incident unchanged.",
      });
    });

    it.each([
      [
        'invalid_store_reset_incident_id',
        'Incident ID must be a canonical lowercase UUID.',
        'Run `coral-cli backend store-reset list --target <legacy|gen2>` and use the ID of an incident in the `ready` state.',
        2,
      ],
      [
        'store_reset_incident_not_found',
        'Store-reset incident not found.',
        'Run `coral-cli backend store-reset list --target <legacy|gen2>`. If no incident is retained, file a Store-reset incident issue with this complete fixed error output; do not attach DB, WAL, SHM, or raw logs.',
        1,
      ],
      [
        'store_reset_incident_limit_exceeded',
        'Too many retained store-reset entries to list safely.',
        'File a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.',
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

    it.each([
      ['legacy_foreign_generation', { legacyPath: '/legacy', version: '0.9.16' }, 409],
      ['legacy_source_not_quiescent', { holder: 'install:kiwi (pid 42)', flavor: 'prod' }, 409],
      ['store_newer_incompatible', { version: '99.0.0', flavor: 'prod' }, 409],
      ['store_older_incompatible', { version: '0.0.1', flavor: 'prod' }, 409],
      ['store_corrupt_or_unsupported', { flavor: 'prod' }, 409],
      ['store_not_initialized', { path: '/store/store.db' }, 409],
      ['kb_commit_corrupt_or_unsupported', { commitId: 'blocking-commit', flavor: 'prod' }, 409],
      ['kb_commit_id_invalid', { commitId: '../bad' }, 400],
      ['kb_commit_not_found', { commitId: 'missing' }, 409],
      ['kb_commit_already_quarantined', { commitId: 'retained', quarantineDir: '/retained' }, 409],
      ['kb_commit_quarantine_failed', { commitId: 'blocking-commit' }, 409],
      ['coordinator_socket_in_use', { operation: 'store reset', retryCommand: 'retry' }, 409],
      ['coordinator_socket_bind_failed', { operation: 'store reset', retryCommand: 'retry' }, 409],
    ] as const)('keeps %s at exit 1 over IPC and HTTP', (code, context, statusCode) => {
      const setupError = documentedCoralSetupError(code, context);
      const serialized = serializeCoralSetupError(setupError);
      if (serialized === null) throw new Error(`Expected ${code} to serialize`);
      const response = buildTransportErrorResponse(setupError);

      expect(response.statusCode).toBe(statusCode);
      expect(
        buildErrorEnvelope(
          new IpcRpcError({
            code: -32603,
            message: serialized.userMessage,
            data: serialized,
          }),
        ).exitCode,
      ).toBe(1);
      expect(
        buildErrorEnvelope(new BackendToolHttpError(response.message, response.statusCode, response.body)).exitCode,
      ).toBe(1);
    });

    it.each([
      ['kb_disabled', 'KB daemon supervisor is disabled: disabled (CORAL_KB_ENABLE=0)'],
      ['kb_initializing', 'Knowledge base is starting up — retry in ~5 seconds'],
      ['kb_offline', 'Knowledge base is offline'],
      ['provider_host_inventory_unavailable', 'Provider-host inventory is temporarily unavailable.'],
    ] as const)('retries %s at exit 75 over IPC even though the wire carries no numeric status', (code, message) => {
      // src/transport/ipc/server.ts's requestErrorResponse puts only the raw domain body
      // (`{code, message, remediation?, detail?}`) on the JSON-RPC error `data` — no
      // `statusCode`/`http` field ever crosses IPC. errorCodeToExit must recognize these
      // three retry-later codes by name, the same way it already does for `transient` and
      // `backend_shutting_down`, or this exact shape falls through to exit 1.
      const envelope = buildErrorEnvelope(
        new IpcRpcError({
          code: -32603,
          message,
          data: { code, message },
        }),
      );

      expect(envelope.exitCode).toBe(75);
    });
  });

  describe('errorCodeToExit', () => {
    it.each([
      ['invalid_usage', undefined, 2],
      ['transient', undefined, 75],
      ['backend_shutting_down', undefined, 75],
      ['kb_disabled', undefined, 75],
      ['kb_initializing', undefined, 75],
      ['kb_offline', undefined, 75],
      ['provider_host_inventory_unavailable', undefined, 75],
      ['backend_error', 503, 75],
      ['backend_unreachable', undefined, 69],
      ['missing_capability', undefined, 77],
      ['child_credentials_incomplete', undefined, 77],
      ['internal', undefined, 70],
      ['internal_error', undefined, 70],
      ['backend_error', 500, 70],
      ['unauthorized', 401, 1],
      ['session_not_found', 404, 1],
      ['not_found', 404, 1],
      ['audit_requires_ended_session', 409, 1],
      ['invalid_request', 400, 1],
      ['backend_recovering', 503, 75],
      // `coordinator_record_unreadable` is observed and durable (a local file this build could not read or
      // decode) — retrying cannot clear it, so it is exit 1, not 75. `coordinator_unreachable` is the one
      // genuinely "could not observe" member of `NOT_OBSERVED_CORAL_SETUP_ERROR_CODES` and stays at 75. See
      // both codes' doc comments in `runtime/errors.ts` for why they split this way.
      ['coordinator_record_unreadable', undefined, 1],
      ['coordinator_unreachable', undefined, 75],
      ['unexpected_code', undefined, 1],
    ])('maps %s / %s to %i', (code, httpStatus, exitCode) => {
      expect(errorCodeToExit(code, httpStatus)).toBe(exitCode);
    });

    // The mechanism `NOT_OBSERVED_CORAL_SETUP_ERROR_CODES` exists to prevent — a code added to one consumer's
    // exit-code list and not the other's — was previously asserted only in a JSDoc comment, never a test. This
    // drives both `errorCodeToExit` (this file) and `expansionExitCode` (`cli/commands/expansion.ts`) from the
    // real exported set, so a future member that either consumer stops honoring fails here instead of shipping
    // silently. `EXPECTED_NOT_OBSERVED_CODES` is an independent, hand-written statement of the set's current
    // membership — mirroring `main-routing.test.ts`'s "has a row for every refusal" pattern — so a code
    // silently added to or removed from the real set is caught here too, not just a drift between consumers.
    it('gives every NOT_OBSERVED_CORAL_SETUP_ERROR_CODES member exit 75 in both errorCodeToExit and expansionExitCode', async () => {
      const EXPECTED_NOT_OBSERVED_CODES = ['coordinator_unreachable'];
      const { NOT_OBSERVED_CORAL_SETUP_ERROR_CODES } = await import('#src/runtime/errors.js');
      const { expansionExitCode } = await import('#src/cli/commands/expansion.js');

      expect([...NOT_OBSERVED_CORAL_SETUP_ERROR_CODES].sort()).toEqual(EXPECTED_NOT_OBSERVED_CODES.sort());

      for (const code of NOT_OBSERVED_CORAL_SETUP_ERROR_CODES) {
        expect(errorCodeToExit(code)).toBe(75);
        expect(expansionExitCode({ status: 'error', code, userMessage: 'unused', remediation: 'unused' })).toBe(75);
      }
    });
  });
});
