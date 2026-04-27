import { basename, dirname } from 'node:path';
import type { ChildProcessLike, ChildStdinLike, StoragePort } from './port-types.js';

type SpawnRecordingEvent = {
  timestamp: number;
  type: 'stdout' | 'stderr' | 'stdin' | 'close' | 'error';
  data?: string;
  code?: number | null;
  signal?: string | null;
};

export type SpawnRecording = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  events: SpawnRecordingEvent[];
};

type SpawnRecordingMetadata = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type RecordableChildProcess = ChildProcessLike & {
  __coralSpawnRecordingMetadata?: SpawnRecordingMetadata;
};

function cloneEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  return env ? { ...env } : undefined;
}

function asText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
}

function nowSince(startedAt: number, now: () => number): number {
  return Math.max(0, now() - startedAt);
}

function ensureObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function ensureOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string when present`);
  }
  return value;
}

function ensureOptionalNullableNumber(value: unknown, path: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number or null when present`);
  }
  return value;
}

function ensureOptionalNullableString(value: unknown, path: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string or null when present`);
  }
  return value;
}

function validateEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const env = ensureObject(value, 'recording.env must be an object when present');
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(env)) {
    if (typeof entry !== 'string') {
      throw new Error(`recording.env.${key} must be a string`);
    }
    normalized[key] = entry;
  }
  return normalized;
}

function validateEvents(value: unknown): SpawnRecordingEvent[] {
  if (!Array.isArray(value)) {
    throw new Error('recording.events must be an array');
  }

  return value.map((entry, index) => {
    const event = ensureObject(entry, `recording.events[${index}] must be an object`);
    const timestamp = event.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
      throw new Error(`recording.events[${index}].timestamp must be a non-negative finite number`);
    }

    const type = event.type;
    if (type !== 'stdout' && type !== 'stderr' && type !== 'stdin' && type !== 'close' && type !== 'error') {
      throw new Error(`recording.events[${index}].type is invalid`);
    }

    return {
      timestamp,
      type,
      data: ensureOptionalString(event.data, `recording.events[${index}].data`),
      code: ensureOptionalNullableNumber(event.code, `recording.events[${index}].code`),
      signal: ensureOptionalNullableString(event.signal, `recording.events[${index}].signal`),
    };
  });
}

export function normalizeSpawnRecording(value: unknown): SpawnRecording {
  const recording = ensureObject(value, 'recording must be an object');
  const command = recording.command;
  if (typeof command !== 'string') {
    throw new Error('recording.command must be a string');
  }

  const argsValue = recording.args;
  if (!Array.isArray(argsValue) || argsValue.some((entry) => typeof entry !== 'string')) {
    throw new Error('recording.args must be an array of strings');
  }

  const normalized: SpawnRecording = {
    command,
    args: [...argsValue],
    events: validateEvents(recording.events),
  };
  const env = validateEnv(recording.env);
  if (env) {
    normalized.env = env;
  }
  return normalized;
}

export function attachSpawnRecordingMetadata(child: ChildProcessLike, metadata: SpawnRecordingMetadata): void {
  (child as RecordableChildProcess).__coralSpawnRecordingMetadata = {
    command: metadata.command,
    args: [...metadata.args],
    env: cloneEnv(metadata.env),
  };
}

export function recordSpawn(child: ChildProcessLike, now: () => number = Date.now): SpawnRecording {
  const metadata = (child as RecordableChildProcess).__coralSpawnRecordingMetadata;
  const startedAt = now();
  const recording: SpawnRecording = {
    command: metadata?.command ?? '',
    args: [...(metadata?.args ?? [])],
    events: [],
  };

  if (metadata?.env) {
    recording.env = cloneEnv(metadata.env);
  }

  const pushEvent = (event: Omit<SpawnRecordingEvent, 'timestamp'>): void => {
    recording.events.push({
      timestamp: nowSince(startedAt, now),
      ...event,
    });
  };

  child.stdout?.setEncoding('utf8').on('data', (chunk: string | Buffer) => {
    pushEvent({ type: 'stdout', data: chunk.toString() });
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string | Buffer) => {
    pushEvent({ type: 'stderr', data: chunk.toString() });
  });

  const stdin = child.stdin as (ChildStdinLike & {
    write: ChildStdinLike['write'];
    end: ChildStdinLike['end'];
  }) | null;
  if (stdin) {
    const originalWrite = stdin.write.bind(stdin);
    const originalEnd = stdin.end.bind(stdin);
    stdin.write = (chunk: string | Uint8Array): boolean => {
      pushEvent({ type: 'stdin', data: asText(chunk) });
      return originalWrite(chunk);
    };
    stdin.end = (chunk?: string | Uint8Array): void => {
      if (chunk !== undefined) {
        pushEvent({ type: 'stdin', data: asText(chunk) });
      }
      originalEnd(chunk);
    };
    stdin.on('error', (error: Error) => {
      pushEvent({ type: 'error', data: `stdin: ${error.message}` });
    });
  }

  child.on('error', (error: Error) => {
    pushEvent({ type: 'error', data: error.message });
  });
  child.on('close', (code, signal) => {
    pushEvent({ type: 'close', code, signal });
  });

  return recording;
}

export function saveRecording(storage: StoragePort, recording: SpawnRecording, filePath: string): void {
  const normalized = normalizeSpawnRecording(recording);
  storage.mkdirSync(dirname(filePath), { recursive: true });
  storage.writeFileSync(filePath, JSON.stringify(normalized, null, 2), { encoding: 'utf-8' });
}

export function loadRecording(storage: StoragePort, filePath: string): SpawnRecording {
  const parsed = JSON.parse(storage.readFileSync(filePath, 'utf-8')) as unknown;
  const recording = normalizeSpawnRecording(parsed);
  recording.events.sort((a, b) => a.timestamp - b.timestamp);
  return recording;
}

export function buildRecordingFilePath(recordingDir: string, command: string, timestamp: number): string {
  const base = basename(command || 'spawn').replace(/[^A-Za-z0-9._-]+/g, '_') || 'spawn';
  return `${recordingDir}/${base}-${timestamp}.json`;
}
