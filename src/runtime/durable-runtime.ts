export interface DurableCliRuntimeRecord {
  transport: 'durable-cli';
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  startTime: string;
  tailWatermark?: number;
}

export function isDurableCliRuntime(
  record: { transport?: string } | null | undefined,
): record is DurableCliRuntimeRecord {
  return record?.transport === 'durable-cli';
}

export interface DurableProcessExit {
  exitCode: number | null;
  signal: string | null;
  endTime: string;
}
