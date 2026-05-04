import { describe, expect, it } from 'vitest';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import { domainResultToHttp } from '#src/transport/response.js';
import { domainError } from '#src/transport/tool-result.js';
import { KB_ID } from '#src/coordinator/subsystems/contract.js';
import { createSubsystemRegistry } from '#src/coordinator/subsystems/registry.js';
import { createStubSubsystem, subsystemPhase } from '../unit/coordinator/subsystems/stub.js';

describe('subsystem-error-envelope invariant', () => {
  it('exposes kb_initializing as a documented code with the transient userMessage/remediation', () => {
    const error = documentedCoralSetupError('kb_initializing');
    expect(error.code).toBe('kb_initializing');
    expect(error.userMessage).toBe('Knowledge base is starting up — retry in ~5 seconds');
    expect(error.remediation).toBe('Wait briefly, then retry the request');
  });

  it('exposes kb_offline as a documented code with the terminal userMessage/remediation', () => {
    const error = documentedCoralSetupError('kb_offline');
    expect(error.code).toBe('kb_offline');
    expect(error.userMessage).toBe('Knowledge base is offline');
    expect(error.remediation).toBe('Restart the daemon: coral-cli backend shutdown');
  });

  it('retains kb_unavailable for the binding_empty translation path (separate from subsystem state)', () => {
    const error = documentedCoralSetupError('kb_unavailable', { readiness: 'fts', binding: 'kb.fts' });
    expect(error.code).toBe('kb_unavailable');
  });

  it('maps kb_initializing, kb_offline, and kb_unavailable to HTTP 503', () => {
    expect(domainResultToHttp(domainError('kb_initializing', 'starting')).statusCode).toBe(503);
    expect(domainResultToHttp(domainError('kb_offline', 'offline')).statusCode).toBe(503);
    expect(domainResultToHttp(domainError('kb_unavailable', 'unavailable')).statusCode).toBe(503);
  });

  it('carries registry remediation through domainResultToHttp', () => {
    const registry = createSubsystemRegistry();
    registry.register(
      createStubSubsystem({
        id: KB_ID,
        initialPhase: subsystemPhase.offline(KB_ID, 'exhausted'),
        resource: {},
      }),
    );

    const response = domainResultToHttp(registry.run(KB_ID, () => ({ ok: true, data: {} })));

    expect(response).toEqual({
      statusCode: 503,
      body: {
        code: 'kb_offline',
        message: 'Knowledge base is offline',
        remediation: 'Restart the daemon: coral-cli backend shutdown',
      },
    });
  });
});
