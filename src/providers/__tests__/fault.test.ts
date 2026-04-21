import { describe, expect, it } from 'vitest';

import type { TerminalOutcome } from '../contract.js';
import { adapterOutputUnparseable, providerRequestFailed, providerSessionUnavailable } from '../fault.js';

describe('provider fault builders', () => {
  it('builds adapter_output_unparseable payloads that round-trip through terminal.outcome', () => {
    const fault = adapterOutputUnparseable({
      provider: 'claude',
      exitCode: 23,
      stdout: 'stdout',
      stderr: 'stderr',
      parseError: 'Unexpected token',
    });
    const outcome: TerminalOutcome = { kind: 'failed', fault };

    expect(fault).toEqual({
      kind: 'adapter_output_unparseable',
      provider: 'claude',
      exitCode: 23,
      stdout: 'stdout',
      stderr: 'stderr',
      parseError: 'Unexpected token',
    });
    expect(outcome).toEqual({
      kind: 'failed',
      fault: {
        kind: 'adapter_output_unparseable',
        provider: 'claude',
        exitCode: 23,
        stdout: 'stdout',
        stderr: 'stderr',
        parseError: 'Unexpected token',
      },
    });
  });

  it('builds provider_session_unavailable payloads that round-trip through terminal.outcome', () => {
    const fault = providerSessionUnavailable({
      provider: 'codex',
      reason: 'thread missing',
    });
    const outcome: TerminalOutcome = { kind: 'failed', fault };

    expect(fault).toEqual({
      kind: 'provider_session_unavailable',
      provider: 'codex',
      reason: 'thread missing',
    });
    expect(outcome).toEqual({
      kind: 'failed',
      fault: {
        kind: 'provider_session_unavailable',
        provider: 'codex',
        reason: 'thread missing',
      },
    });
  });

  it('builds provider_request_failed payloads that round-trip through terminal.outcome', () => {
    const cause = new Error('upstream failed');
    const fault = providerRequestFailed({
      provider: 'claude',
      message: 'request failed',
      cause,
    });
    const outcome: TerminalOutcome = { kind: 'failed', fault };

    expect(fault).toEqual({
      kind: 'provider_request_failed',
      provider: 'claude',
      message: 'request failed',
      cause,
    });
    expect(outcome).toEqual({
      kind: 'failed',
      fault: {
        kind: 'provider_request_failed',
        provider: 'claude',
        message: 'request failed',
        cause,
      },
    });
  });
});
