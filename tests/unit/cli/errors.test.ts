import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { BackendToolHttpError } from '#src/transport/http/errors.js';
import { BackendUnreachableError, TransientHttpError } from '#src/infra/http-errors.js';
import { StoreResetCliError, UsageError, buildErrorEnvelope, errorCodeToExit } from '#src/cli/errors.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import { buildTransportErrorResponse } from '#src/transport/error-response.js';
import { ChildPrincipalBindingError } from '#src/transport/ipc/child-principal-auth.js';
import { IpcDrainRequestUnanswered, IpcLifecycleRefusal, IpcRpcError } from '#src/transport/ipc/client.js';

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

    it('retries a still-starting backend over IPC, where no HTTP status accompanies the code', () => {
      // The HTTP mapping cannot reach this path: IPC carries the code and no status.
      expect(errorCodeToExit('startup_not_ready')).toBe(75);
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

    it('prints a provider preflight fault cause from a structured transport error before dropping its context', () => {
      const cause = 'preflight implementation failed';
      const error = documentedCoralSetupError('provider_preflight_faulted', { provider: 'codex', cause });
      const response = buildTransportErrorResponse(error);

      expect(response.statusCode).toBe(500);
      expect(response.body).toMatchObject({ context: { provider: 'codex', cause } });
      expect(
        buildErrorEnvelope(new BackendToolHttpError(response.message, response.statusCode, response.body)),
      ).toEqual({
        envelope: {
          error: true,
          code: 'provider_preflight_faulted',
          message: `Coral's codex provider preflight failed internally: ${cause}`,
          remediation:
            'Report provider_preflight_faulted with the complete error message. This internal fault does not establish whether the provider is installed, available, or authenticated; do not reinstall or re-authenticate based on this error.',
        },
        exitCode: 70,
      });
    });

    it('preserves the unknown-writer code from a setup error through the HTTP envelope', () => {
      const failure = documentedCoralSetupError('legacy_source_writer_observation_unknown', {
        holder: 'install:kiwi (pid 42)',
      });
      const response = buildTransportErrorResponse(failure);

      expect(buildErrorEnvelope(failure)).toMatchObject({
        envelope: { code: 'legacy_source_writer_observation_unknown' },
        exitCode: 75,
      });
      expect(response.statusCode).toBe(409);
      expect(
        buildErrorEnvelope(new BackendToolHttpError(response.message, response.statusCode, response.body)),
      ).toMatchObject({
        envelope: { code: 'legacy_source_writer_observation_unknown' },
        exitCode: 75,
      });
    });

    it('keeps store-reset reporting failures public without diagnostic context', () => {
      const result = buildErrorEnvelope(new StoreResetCliError('store_reset_reporting_failed'));

      expect(result).toMatchObject({
        envelope: { error: true, code: 'store_reset_reporting_failed' },
        exitCode: 70,
      });
      expect(result.envelope.remediation).toContain('do not move, restore, delete, or attach');
      expect(result.envelope).not.toHaveProperty('detail');
      expect(result.envelope).not.toHaveProperty('context');
      expect(result.envelope).not.toHaveProperty('http');
    });

    it('renders a reached coordinator lifecycle refusal as a bounded asynchronous wait', () => {
      const result = buildErrorEnvelope(new IpcLifecycleRefusal('/tmp/coral.sock', 'jobs.abort'));

      expect(result.exitCode).toBe(75);
      expect(result.envelope.code).toBe('backend_shutting_down');
      expect(result.envelope.message).toContain('jobs.abort');
      expect(result.envelope.message).toContain('/tmp/coral.sock');
      expect(result.envelope.message).not.toContain('while draining');
      expect(result.envelope.remediation).toContain('coral-cli backend status');
      expect(result.envelope.remediation).toContain('bounded asynchronous wait');
      expect(result.envelope.remediation).toContain('Retry this command after');
    });

    it.each([
      ['a refusal whose address may still be released', new IpcLifecycleRefusal('/tmp/coral.sock', 'jobs.abort')],
      [
        'a refusal whose coordinator kept the address',
        new IpcLifecycleRefusal('/tmp/coral.sock', 'jobs.abort').stillHoldingAddress(30_000),
      ],
    ])('discloses that the refused method never ran for %s', (_case, refusal) => {
      const { envelope } = buildErrorEnvelope(refusal);

      expect(envelope.remediation).toContain('refused jobs.abort without running it');
    });

    it('reports when to retry in both address-disposition branches', () => {
      const unobserved = buildErrorEnvelope(new IpcLifecycleRefusal('/tmp/coral.sock', 'jobs.abort')).envelope
        .remediation;
      const held = buildErrorEnvelope(
        new IpcLifecycleRefusal('/tmp/coral.sock', 'jobs.abort').stillHoldingAddress(30_000),
      ).envelope.remediation;

      for (const remediation of [unobserved, held]) {
        expect(remediation).toContain('bounded asynchronous wait');
        expect(remediation).toContain(
          'Retry this command after `coral-cli backend status` no longer reports that coordinator as shutting down.',
        );
      }
      expect(unobserved).not.toContain('bounded wait for the coordinator address to be released expired');
      expect(held).toContain("The CLI's 30s bounded wait for the coordinator address to be released expired.");
    });

    it('folds a refusal carried as cause into the surfacing failure without taking over its class', () => {
      const refusal = new IpcLifecycleRefusal('/tmp/coral.sock', 'jobs.abort');
      const surfacing = new BackendUnreachableError('Coral coordinator socket was never bound.');
      surfacing.cause = refusal;

      const result = buildErrorEnvelope(surfacing);

      expect(result.exitCode).toBe(69);
      expect(result.envelope.code).toBe('backend_unreachable');
      expect(result.envelope.message).toBe('Coral coordinator socket was never bound.');
      expect(result.envelope.remediation).toContain('refused jobs.abort');
      expect(result.envelope.remediation).toContain('bounded asynchronous wait');
    });

    it('reaches a refusal nested behind an intermediate cause, and appends nothing when there is none', () => {
      const refusal = new IpcLifecycleRefusal('/tmp/coral.sock', 'coordinator.provider_proxy_set.contain.v2');
      const intermediate = new Error('spawning a successor failed');
      intermediate.cause = refusal;
      const surfacing = new BackendUnreachableError('Coral coordinator could not be replaced.');
      surfacing.cause = intermediate;

      expect(buildErrorEnvelope(surfacing).envelope.remediation).toContain(
        'refused coordinator.provider_proxy_set.contain.v2',
      );

      const unrelated = new BackendUnreachableError('Coral coordinator could not be replaced.');
      unrelated.cause = new Error('socket directory is unreadable');
      expect(buildErrorEnvelope(unrelated).envelope.remediation).toBeUndefined();
    });

    it('renders a drain-bounded request that was never answered as an unknown disposition, not a refusal', () => {
      const result = buildErrorEnvelope(new IpcDrainRequestUnanswered('/tmp/coral.sock', 'jobs.abort', 30_000));

      expect(result.exitCode).toBe(75);
      expect(result.envelope.code).toBe('coordinator_drain_unanswered');
      expect(result.envelope.code).not.toBe('backend_shutting_down');
      expect(result.envelope.message).toContain('did not answer jobs.abort within 30s');
      expect(result.envelope.message).toContain('/tmp/coral.sock');
      expect(result.envelope.message).toContain('whether jobs.abort ran is unknown');
      expect(result.envelope.remediation).toBe(
        'Do not retry before `coral-cli backend status`: whether jobs.abort ran is unknown.',
      );
    });

    it('distinguishes a refusal whose coordinator kept the address from one that may still release it', () => {
      const refused = new IpcLifecycleRefusal('/tmp/coral.sock', 'jobs.abort');
      const held = refused.stillHoldingAddress(30_000);

      expect(held.addressDisposition).toEqual({ kind: 'held-past-release-budget', budgetMs: 30_000 });
      expect(held.message).toContain('still held that address 30s later');
      expect(held.message).not.toContain('while draining');

      const heldEnvelope = buildErrorEnvelope(held);
      expect(heldEnvelope.exitCode).toBe(75);
      expect(heldEnvelope.envelope.remediation).toContain(
        "The CLI's 30s bounded wait for the coordinator address to be released expired.",
      );
      expect(buildErrorEnvelope(refused).envelope.remediation).not.toContain(
        'bounded wait for the coordinator address to be released expired',
      );
    });

    it.each([
      [{ code: 'unauthorized', message: 'Unauthorized' }, 401, 1],
      [{ code: 'backend_error', message: 'Retry later' }, 503, 75],
      [{ code: 'backend_error', message: 'Server exploded' }, 500, 70],
      [{ code: 'not_found', message: 'Not found' }, 404, 1],
    ])('uses backend code/status combinations %j / %i -> %i', (body, statusCode, exitCode) => {
      expect(buildErrorEnvelope(new BackendToolHttpError(body.message, statusCode, body)).exitCode).toBe(exitCode);
    });

    it('retries a recovering backend over IPC without an HTTP status', () => {
      const result = buildErrorEnvelope(
        new IpcRpcError({
          code: -32603,
          message: 'Recovery pending',
          data: { code: 'backend_recovering', message: 'Recovery pending' },
        }),
      );

      expect(result.exitCode).toBe(75);
    });

    it.each([
      ['provider_preflight_undetermined', 75],
      ['provider_preflight_failed', 1],
    ] as const)('maps IPC launch code %s to exit %i without an HTTP status', (code, exitCode) => {
      const envelope = buildErrorEnvelope(
        new IpcRpcError({
          code: -32603,
          message: 'Provider preflight result',
          data: { code, message: 'Provider preflight result' },
        }),
      );

      expect(envelope.exitCode).toBe(exitCode);
    });
  });

  describe('errorCodeToExit', () => {
    it.each([
      ['invalid_usage', undefined, 2],
      ['legacy_source_writer_observation_unknown', undefined, 75],
      ['transient', undefined, 75],
      ['wait_snapshot_too_large', undefined, 75],
      ['busy', undefined, 75],
      ['backend_error', 503, 75],
      ['coordinator_socket_dir_insecure', undefined, 1],
      ['backend_unreachable', undefined, 69],
      ['missing_capability', undefined, 77],
      ['internal', undefined, 70],
      ['backend_error', 500, 70],
      ['unexpected_code', undefined, 1],
    ])('maps %s / %s to %i', (code, httpStatus, exitCode) => {
      expect(errorCodeToExit(code, httpStatus)).toBe(exitCode);
    });
  });
});
