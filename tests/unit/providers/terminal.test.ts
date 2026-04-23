import { describe, expect, it } from 'vitest';

import type { JobTerminal, TerminalOutcome } from '#src/providers/contract.js';
import { adapterOutputUnparseable } from '#src/providers/fault.js';
import { buildJobDiagnostics, buildJobTerminal } from '#src/providers/terminal.js';

describe('buildJobTerminal', () => {
  it.each([
    ['completed', { kind: 'completed' } satisfies TerminalOutcome],
    ['aborted', { kind: 'aborted', reason: 'signal_abort' } satisfies TerminalOutcome],
    [
      'failed',
      {
        kind: 'failed',
        fault: adapterOutputUnparseable({
          provider: 'claude',
          exitCode: 7,
          stdout: 'stdout',
          stderr: 'stderr',
          parseError: 'parse failed',
        }),
      } satisfies TerminalOutcome,
    ],
  ] as const)('builds the native JobTerminal shape for %s outcomes', (_label, outcome) => {
    const terminal: JobTerminal = buildJobTerminal({
      content: 'terminal content',
      model: 'test-model',
      outcome,
      durationMs: 42,
      exitCode: 0,
      usage: { inputTokens: 11, outputTokens: 13, costUsd: 0.5 },
      warnings: ['check warnings'],
    });

    expect(terminal).toEqual({
      content: 'terminal content',
      model: 'test-model',
      outcome,
      durationMs: 42,
      exitCode: 0,
      usage: { inputTokens: 11, outputTokens: 13, costUsd: 0.5 },
      warnings: ['check warnings'],
    });
  });

  it('maps executor-style success results into the native completed terminal shape', () => {
    expect(
      buildJobTerminal({
        response: 'executor output',
        model: 'claude-sonnet',
        durationMs: 19,
      }),
    ).toEqual({
      content: 'executor output',
      model: 'claude-sonnet',
      durationMs: 19,
      outcome: { kind: 'completed' },
    });
  });

  it('maps executor-style aborted results into the native aborted terminal shape', () => {
    expect(
      buildJobTerminal({
        response: 'executor output',
        model: 'claude-sonnet',
        durationMs: 19,
        aborted: true,
        warnings: ['interrupted'],
      }),
    ).toEqual({
      content: 'executor output',
      model: 'claude-sonnet',
      durationMs: 19,
      outcome: { kind: 'aborted', reason: 'signal_abort' },
      warnings: ['interrupted'],
    });
  });
});

describe('buildJobDiagnostics', () => {
  it('captures byteCounts and warnings', () => {
    expect(
      buildJobDiagnostics({
        stdout: new Uint8Array([1, 2, 3]),
        stderr: 'warn',
        warnings: ['partial output'],
      }),
    ).toEqual({
      byteCounts: {
        stdout: 3,
        stderr: 4,
      },
      warnings: ['partial output'],
    });
  });

  it('round-trips precomputed byte counts', () => {
    expect(
      buildJobDiagnostics({
        byteCounts: {
          stdout: 12,
          stderr: 8,
        },
      }),
    ).toEqual({
      byteCounts: {
        stdout: 12,
        stderr: 8,
      },
    });
  });
});
