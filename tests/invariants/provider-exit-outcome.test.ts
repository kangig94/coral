// Spec §7.1 line 1041 + §13.1 transaction 5: live execution that exits
// non-zero with no upstream domain cause produces a `provider_exit` outcome
// — not `failed` with a synthesized provider request failure cause.
//
// This invariant tests the materializer dispatch (the boundary between
// ProviderTerminalOutcome from the kernel and TerminalOutcome on the
// `job.terminal.recorded` envelope) and asserts that `provider_exit` is a
// 1:1 passthrough rather than being translated into a failed cause chain.

import { describe, expect, it } from 'vitest';

import { materializeProviderTerminal } from '#src/coordinator/services/terminal-materializer.js';
import type { ProviderTerminalEventBody } from '#src/providers/contract.js';

const baseTerminal = (overrides: Partial<ProviderTerminalEventBody['terminal']>): ProviderTerminalEventBody => ({
  kind: 'terminal',
  terminal: {
    content: '',
    durationMs: 100,
    ...overrides,
    outcome: overrides.outcome ?? { kind: 'completed' },
  },
  diagnostics: {},
});

describe('provider_exit outcome materialization', () => {
  it('passes provider_exit { code, note } through 1:1 to the planned terminal outcome', () => {
    const recipe = materializeProviderTerminal(
      baseTerminal({ outcome: { kind: 'provider_exit', code: 1, note: 'Codex turn failed.' } }),
      { jobId: 'job-1' },
    );

    expect(recipe.outcomePlan).toEqual({
      kind: 'immediate',
      domainEvents: [],
      immediateOutcome: { kind: 'provider_exit', code: 1, note: 'Codex turn failed.' },
    });
  });

  it('preserves a numeric exit code without a note', () => {
    const recipe = materializeProviderTerminal(baseTerminal({ outcome: { kind: 'provider_exit', code: 137 } }), {
      jobId: 'job-2',
    });

    expect(recipe.outcomePlan).toEqual({
      kind: 'immediate',
      domainEvents: [],
      immediateOutcome: { kind: 'provider_exit', code: 137 },
    });
  });
});
