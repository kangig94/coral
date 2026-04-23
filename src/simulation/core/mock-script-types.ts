import type { DurableCliRuntimeRecord } from '../../runtime/durable-runtime.js';
import type { ChildProcessLike, ExecResult } from '../../runtime/ports.js';

export type ChildOutputChunk = {
  delayMs?: number;
  data: string;
};

export type MockKillAction = {
  signal?: NodeJS.Signals | 0 | 'default';
  delayMs?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
};

export type MockSpawnChild = ChildProcessLike & {
  pushStdout(value: string): void;
};

export type MockSpawnContext = {
  child: MockSpawnChild;
  schedule: (delayMs: number, fn: () => void) => void;
  close: (outcome?: { code?: number | null; signal?: string | null }) => void;
  fail: (error: Error | string) => void;
};

export type MockSpawnScript = {
  pid?: number;
  stdout?: string | ChildOutputChunk[];
  stderr?: string | ChildOutputChunk[];
  onSpawn?: (context: MockSpawnContext) => void;
  close?: {
    delayMs?: number;
    code?: number | null;
    signal?: string | null;
  } | null;
  error?: {
    delayMs?: number;
    error: Error | string;
  } | null;
  kills?: MockKillAction[];
};

export type MockDurableScript = {
  pid?: number;
  runtimeDelayMs?: number;
  stdout?: string | ChildOutputChunk[];
  stderr?: string | ChildOutputChunk[];
  runtimeRecord?: Partial<DurableCliRuntimeRecord>;
  exit?: {
    delayMs?: number;
    exitCode?: number | null;
    signal?: string | null;
  } | null;
  kills?: MockKillAction[];
  waitForExitError?: Error | string;
};

export type MockExecSyncScript = {
  command: string;
  args: string[];
  result: ExecResult;
};
