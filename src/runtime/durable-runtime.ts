export interface DurableCliRuntimeRecord {
  transport?: 'durable-cli';
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  startTime: string;
  providerMeta?: Record<string, unknown>;
  tailWatermark?: number;
}

export function isDurableCliRuntime(
  record: { transport?: string } | null | undefined,
): record is DurableCliRuntimeRecord {
  return record !== null && record !== undefined && record.transport !== 'app-server';
}

export interface DurableProcessExit {
  exitCode: number | null;
  signal: string | null;
  endTime: string;
}
