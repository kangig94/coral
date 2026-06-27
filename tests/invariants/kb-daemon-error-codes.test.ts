import { describe, expect, it } from 'vitest';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import { domainResultToHttp } from '#src/transport/response.js';
import { domainError } from '#src/transport/tool-result.js';

describe('kb-daemon-error-codes invariant', () => {
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

  it('retains kb_unavailable for the binding_empty translation path (separate from component state)', () => {
    const error = documentedCoralSetupError('kb_unavailable', { readiness: 'fts', binding: 'kb.fts' });
    expect(error.code).toBe('kb_unavailable');
  });

  it('maps kb_initializing, kb_offline, and kb_unavailable to HTTP 503', () => {
    expect(domainResultToHttp(domainError('kb_initializing', 'starting')).statusCode).toBe(503);
    expect(domainResultToHttp(domainError('kb_offline', 'offline')).statusCode).toBe(503);
    expect(domainResultToHttp(domainError('kb_unavailable', 'unavailable')).statusCode).toBe(503);
  });

  it('maps kb_daemon_protocol_error to HTTP 502 (upstream daemon returned a bad response)', () => {
    expect(domainResultToHttp(domainError('kb_daemon_protocol_error', 'malformed read result')).statusCode).toBe(502);
  });

  it('carries KB daemon remediation through domainResultToHttp', () => {
    const response = domainResultToHttp({
      ok: false,
      code: 'kb_offline',
      message: 'Knowledge base is offline',
      remediation: 'Restart the daemon: coral-cli backend shutdown',
    });
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
