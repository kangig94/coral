import { describe, expect, it } from 'vitest';

import { classifyCodexProviderResponseServiceability } from '#src/providers/codex/serviceability.js';
import { classifyProviderResponseServiceability } from '#src/providers/serviceability.js';
import type { ProviderResponseDiagnosticFact } from '#src/providers/host-diagnostics.js';

describe('Codex provider response serviceability', () => {
  it('classifies the required config/read prerequisite from typed method and result fields', () => {
    expect(classifyCodexProviderResponseServiceability(fact('config/read', { kind: 'success' }))).toBe('serviceable');
    expect(
      classifyCodexProviderResponseServiceability(
        fact('config/read', {
          kind: 'failure',
          rpcCode: -32_603,
          providerMessage: 'configuration refused',
          providerData: { reason: 'invalid configuration' },
        }),
      ),
    ).toBe('unserviceable');
  });

  it('does not over-broadly classify an ordinary provider rejection as unserviceable', () => {
    expect(
      classifyCodexProviderResponseServiceability(
        fact('thread/start', {
          kind: 'failure',
          rpcCode: -32_000,
          providerMessage: 'benign operation rejection',
          providerData: { retryable: true },
        }),
      ),
    ).toBe('unknown');
  });

  it('does not interpret provider prose containing config/read as prerequisite identity', () => {
    expect(
      classifyCodexProviderResponseServiceability(
        fact('thread/start', {
          kind: 'failure',
          rpcCode: -32_000,
          providerMessage: 'operation rejected after config/read was mentioned',
          providerData: null,
        }),
      ),
    ).toBe('unknown');
  });

  it('registers the Codex classifier and leaves providers without a classifier unknown', () => {
    const prerequisite = fact('config/read', { kind: 'success' });
    expect(classifyProviderResponseServiceability('codex', prerequisite)).toBe('serviceable');
    expect(classifyProviderResponseServiceability('claude', prerequisite)).toBe('unknown');
  });
});

function fact(method: string, response: ProviderResponseDiagnosticFact['response']): ProviderResponseDiagnosticFact {
  return Object.freeze({
    factSeq: 1,
    generation: 7,
    requestId: 11,
    method,
    response: Object.freeze(response),
    hostLog: Object.freeze({ startSeq: 3, endSeq: 5 }),
  });
}
