import { Buffer } from 'node:buffer';

import type { JobDiagnostics, JobTerminal } from './contract.js';

type DirectJobTerminalInput = {
  content: string;
  outcome: JobTerminal['outcome'];
  model?: JobTerminal['model'];
  usage?: JobTerminal['usage'];
  durationMs?: JobTerminal['durationMs'];
  exitCode?: JobTerminal['exitCode'];
  warnings?: JobTerminal['warnings'];
};

type ExecResultTerminalInput = {
  response: string;
  model: string;
  durationMs: number;
  aborted?: boolean;
  usage?: JobTerminal['usage'];
  exitCode?: JobTerminal['exitCode'];
  warnings?: JobTerminal['warnings'];
};

type BuildJobTerminalInput = DirectJobTerminalInput | ExecResultTerminalInput;

type DirectJobDiagnosticsInput = {
  byteCounts?: JobDiagnostics['byteCounts'];
  warnings?: JobDiagnostics['warnings'];
};

type StreamDiagnosticsInput = {
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
  warnings?: JobDiagnostics['warnings'];
};

type BuildJobDiagnosticsInput = {
  byteCounts?: JobDiagnostics['byteCounts'];
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
  warnings?: JobDiagnostics['warnings'];
};

export function buildJobTerminal(input: DirectJobTerminalInput): JobTerminal;
export function buildJobTerminal(input: ExecResultTerminalInput): JobTerminal;
export function buildJobTerminal(input: BuildJobTerminalInput): JobTerminal {
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

export function buildJobDiagnostics(input: DirectJobDiagnosticsInput): JobDiagnostics;
export function buildJobDiagnostics(input: StreamDiagnosticsInput): JobDiagnostics;
export function buildJobDiagnostics(input: BuildJobDiagnosticsInput): JobDiagnostics {
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

function resolveByteCounts(input: BuildJobDiagnosticsInput): JobDiagnostics['byteCounts'] {
  if (input.stdout === undefined && input.stderr === undefined) {
    return input.byteCounts;
  }
  return {
    stdout: countBytes(input.stdout),
    stderr: countBytes(input.stderr),
  };
}
