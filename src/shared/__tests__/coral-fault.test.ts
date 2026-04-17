import { describe, expect, it } from 'vitest';

import {
  coralFaultSchema,
  describeCoralFault,
  phaseForOutcome,
  terminalOutcomeSchema,
  type CoralFault,
  type TerminalOutcome,
} from '../coral-fault.js';

type ParseResult<T> = { success: true; data: T } | { success: false; error: unknown };

function expectSafeParseSuccess<T>(result: ParseResult<T>): T {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}

function roundTripFault(fault: CoralFault): CoralFault {
  const parsed = expectSafeParseSuccess(coralFaultSchema.safeParse(fault));
  const reparsed = expectSafeParseSuccess(coralFaultSchema.safeParse(JSON.parse(JSON.stringify(parsed))));
  expect(reparsed).toEqual(parsed);
  return reparsed;
}

function roundTripOutcome(outcome: TerminalOutcome): TerminalOutcome {
  const parsed = expectSafeParseSuccess(terminalOutcomeSchema.safeParse(outcome));
  const reparsed = expectSafeParseSuccess(terminalOutcomeSchema.safeParse(JSON.parse(JSON.stringify(parsed))));
  expect(reparsed).toEqual(parsed);
  return reparsed;
}

const baseFaultFixtures: readonly CoralFault[] = [
  { kind: 'stale_status_schema' },
  { kind: 'ghost_launch' },
  { kind: 'wrapper_lost' },
  { kind: 'wrapper_crashed', cause: { message: 'wrapper exploded', stack: 'boom' } },
  { kind: 'recovery_parse_failed', cause: { message: 'bad recovery snapshot' } },
  {
    kind: 'launch_rejected',
    reason: 'busy',
    message: 'provider is saturated',
    provider: 'claude',
    globalActive: 5,
    globalLimit: 8,
  },
  { kind: 'app_server_interrupted', trigger: 'restart', continuity: 'verified' },
  { kind: 'workflow_atom_failed', step: 3, atom: 'draft_reply', cause: { message: 'atom failed', stack: 'trace' } },
  { kind: 'workflow_aborted' },
  {
    kind: 'adapter_output_unparseable',
    provider: 'claude',
    exitCode: 17,
    stdout: 'not json',
    stderr: 'stderr',
    parseError: 'Unexpected token',
  },
  { kind: 'provider_session_unavailable', provider: 'codex', note: 'thread missing' },
  { kind: 'provider_request_failed', provider: 'claude', message: 'backend rejected the turn' },
] as const;

describe('coralFaultSchema', () => {
  it('round-trips each of the 12 fault kinds', () => {
    const roundTrippedKinds = new Set(baseFaultFixtures.map((fault) => roundTripFault(fault).kind));

    expect(roundTrippedKinds).toEqual(
      new Set([
        'stale_status_schema',
        'ghost_launch',
        'wrapper_lost',
        'wrapper_crashed',
        'recovery_parse_failed',
        'launch_rejected',
        'app_server_interrupted',
        'workflow_atom_failed',
        'workflow_aborted',
        'adapter_output_unparseable',
        'provider_session_unavailable',
        'provider_request_failed',
      ]),
    );
  });

  it('round-trips workflow_atom_failed with and without step and atom', () => {
    const withMetadata: CoralFault = {
      kind: 'workflow_atom_failed',
      step: 8,
      atom: 'run_checks',
      cause: { message: 'step failed', stack: 'trace' },
    };
    const withoutMetadata: CoralFault = {
      kind: 'workflow_atom_failed',
      cause: { message: 'drain failure' },
    };

    expect(roundTripFault(withMetadata)).toEqual(withMetadata);
    expect(roundTripFault(withoutMetadata)).toEqual(withoutMetadata);
  });
});

describe('describeCoralFault', () => {
  it('returns a non-empty string for each fault kind', () => {
    for (const fault of baseFaultFixtures) {
      expect(describeCoralFault(fault).trim().length).toBeGreaterThan(0);
    }
  });

  it('renders workflow_atom_failed with and without structured metadata without leaking undefined', () => {
    const withMetadata = describeCoralFault({
      kind: 'workflow_atom_failed',
      step: 5,
      atom: 'collect_context',
      cause: { message: 'network timeout' },
    });
    const withoutMetadata = describeCoralFault({
      kind: 'workflow_atom_failed',
      cause: { message: 'network timeout' },
    });

    expect(withMetadata).toBe("Workflow step 5 atom 'collect_context' failed: network timeout.");
    expect(withoutMetadata).toBe('Workflow failed: network timeout.');
    expect(withMetadata).not.toContain('undefined');
    expect(withoutMetadata).not.toContain('undefined');
  });

  it('includes the capitalized provider name for every provider-scoped variant', () => {
    const providerScopedCases: ReadonlyArray<readonly [fault: CoralFault, providerName: 'Claude' | 'Codex']> = [
      [
        {
          kind: 'adapter_output_unparseable',
          provider: 'claude',
          exitCode: null,
          stdout: '',
          stderr: '',
          parseError: 'Invalid JSON payload',
        },
        'Claude',
      ],
      [
        {
          kind: 'provider_session_unavailable',
          provider: 'codex',
          note: 'session reference expired',
        },
        'Codex',
      ],
      [
        {
          kind: 'provider_request_failed',
          provider: 'claude',
          message: 'turn failed',
        },
        'Claude',
      ],
    ];

    for (const [fault, providerName] of providerScopedCases) {
      const description = describeCoralFault(fault);
      expect(description.length).toBeGreaterThan(0);
      expect(description).toContain(providerName);
    }
  });

  it('produces pairwise-distinct app_server_interrupted sentences with trigger and continuity tokens', () => {
    const triggers = ['restart', 'handoff'] as const;
    const continuities = [
      'verified',
      'missing',
      'unavailable',
      'pre_checkpoint_empty',
      'pre_checkpoint_preserved',
    ] as const;
    const continuityTokens = {
      verified: 'verified',
      missing: 'missing',
      unavailable: 'unavailable',
      pre_checkpoint_empty: 'no resumable conversation was available',
      pre_checkpoint_preserved: 'existing conversation reference was preserved',
    } as const;
    const triggerTokens = {
      restart: 'restarted',
      handoff: 'handoff',
    } as const;

    const sentences = triggers.flatMap((trigger) =>
      continuities.map((continuity) => {
        const sentence = describeCoralFault({
          kind: 'app_server_interrupted',
          trigger,
          continuity,
        });
        expect(sentence).toContain(triggerTokens[trigger]);
        expect(sentence).toContain(continuityTokens[continuity]);
        return sentence;
      }),
    );

    expect(sentences).toHaveLength(10);
    expect(new Set(sentences).size).toBe(10);
  });
});

describe('terminalOutcomeSchema', () => {
  it('round-trips all terminal outcome variants', () => {
    expect(roundTripOutcome({ kind: 'completed' })).toEqual({ kind: 'completed' });
    expect(roundTripOutcome({ kind: 'provider_exit', code: 0, note: 'clean exit' })).toEqual({
      kind: 'provider_exit',
      code: 0,
      note: 'clean exit',
    });
    expect(roundTripOutcome({ kind: 'coral_fault', fault: { kind: 'wrapper_lost' } })).toEqual({
      kind: 'coral_fault',
      fault: { kind: 'wrapper_lost' },
    });
  });

  it('round-trips aborted outcomes for each supported token and rejects free-form prose', () => {
    expect(roundTripOutcome({ kind: 'aborted', reason: 'signal_abort' })).toEqual({
      kind: 'aborted',
      reason: 'signal_abort',
    });
    expect(roundTripOutcome({ kind: 'aborted', reason: 'user_abort' })).toEqual({
      kind: 'aborted',
      reason: 'user_abort',
    });
    expect(roundTripOutcome({ kind: 'aborted', reason: 'queue_shutdown' })).toEqual({
      kind: 'aborted',
      reason: 'queue_shutdown',
    });

    const invalid = terminalOutcomeSchema.safeParse({
      kind: 'aborted',
      reason: 'Aborted by signal',
    });
    expect(invalid.success).toBe(false);
  });
});

describe('phaseForOutcome', () => {
  it('maps each terminal outcome to the expected job phase', () => {
    expect(phaseForOutcome({ kind: 'completed' })).toBe('completed');
    expect(phaseForOutcome({ kind: 'aborted', reason: 'signal_abort' })).toBe('aborted');
    expect(phaseForOutcome({ kind: 'provider_exit', code: 0 })).toBe('completed');
    expect(phaseForOutcome({ kind: 'provider_exit', code: 23, note: 'failure' })).toBe('error');
    expect(phaseForOutcome({ kind: 'coral_fault', fault: { kind: 'wrapper_crashed', cause: { message: 'boom' } } })).toBe(
      'error',
    );
  });
});
