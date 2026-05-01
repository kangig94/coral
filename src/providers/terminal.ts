import { Buffer } from 'node:buffer';

import type { ProviderJobDiagnostics, ProviderTerminal } from './contract.js';

type DirectJobTerminalInput = {
  content: string;
  outcome: ProviderTerminal['outcome'];
  model?: ProviderTerminal['model'];
  usage?: ProviderTerminal['usage'];
  durationMs?: ProviderTerminal['durationMs'];
  exitCode?: ProviderTerminal['exitCode'];
  warnings?: ProviderTerminal['warnings'];
};

type ExecResultTerminalInput = {
  response: string;
  model: string;
  durationMs: number;
  aborted?: boolean;
  usage?: ProviderTerminal['usage'];
  exitCode?: ProviderTerminal['exitCode'];
  warnings?: ProviderTerminal['warnings'];
};

type BuildJobTerminalInput = DirectJobTerminalInput | ExecResultTerminalInput;

type DirectJobDiagnosticsInput = {
  byteCounts?: ProviderJobDiagnostics['byteCounts'];
  warnings?: ProviderJobDiagnostics['warnings'];
};

type StreamDiagnosticsInput = {
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
  warnings?: ProviderJobDiagnostics['warnings'];
};

type BuildJobDiagnosticsInput = {
  byteCounts?: ProviderJobDiagnostics['byteCounts'];
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
  warnings?: ProviderJobDiagnostics['warnings'];
};

export function buildJobTerminal(input: DirectJobTerminalInput): ProviderTerminal;
export function buildJobTerminal(input: ExecResultTerminalInput): ProviderTerminal;
export function buildJobTerminal(input: BuildJobTerminalInput): ProviderTerminal {
  if ('content' in input) {
    return {
      content: input.content,
      outcome: input.outcome,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.usage === undefined ? {} : { usage: { ...input.usage } }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.warnings === undefined ? {} : { warnings: [...input.warnings] }),
    };
  }

  return {
    content: input.response,
    model: input.model,
    durationMs: input.durationMs,
    outcome: input.aborted ? { kind: 'aborted', reason: 'signal_abort' } : { kind: 'completed' },
    ...(input.usage === undefined ? {} : { usage: { ...input.usage } }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.warnings === undefined ? {} : { warnings: [...input.warnings] }),
  };
}

export function buildJobDiagnostics(input: DirectJobDiagnosticsInput): ProviderJobDiagnostics;
export function buildJobDiagnostics(input: StreamDiagnosticsInput): ProviderJobDiagnostics;
export function buildJobDiagnostics(input: BuildJobDiagnosticsInput): ProviderJobDiagnostics {
  const byteCounts = resolveByteCounts(input);

  return {
    ...(byteCounts === undefined ? {} : { byteCounts: { ...byteCounts } }),
    ...(input.warnings === undefined ? {} : { warnings: [...input.warnings] }),
  };
}

function countBytes(value: string | Uint8Array | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(value);
  }
  return value.byteLength;
}

function resolveByteCounts(input: BuildJobDiagnosticsInput): ProviderJobDiagnostics['byteCounts'] {
  if (input.stdout === undefined && input.stderr === undefined) {
    return input.byteCounts;
  }
  return {
    stdout: countBytes(input.stdout),
    stderr: countBytes(input.stderr),
  };
}
