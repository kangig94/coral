import type { MockDurableScript, MockSpawnScript } from './core/mock-script-types.js';
import { normalizeSpawnRecording, type SpawnRecording } from '../../src/infra/spawn-recording.js';

function findFirstEvent(
  recording: SpawnRecording,
  type: SpawnRecording['events'][number]['type'],
): SpawnRecording['events'][number] | undefined {
  return recording.events.find((event) => event.type === type);
}

function collectChunks(recording: SpawnRecording, type: 'stdout' | 'stderr') {
  const chunks = recording.events
    .filter((event) => event.type === type && typeof event.data === 'string')
    .map((event) => ({
      delayMs: event.timestamp,
      data: event.data as string,
    }));

  return chunks.length > 0 ? chunks : undefined;
}

function toReplayError(
  event: SpawnRecording['events'][number] | undefined,
): Error | undefined {
  if (!event || typeof event.data !== 'string' || event.data.length === 0) {
    return undefined;
  }
  return new Error(event.data);
}

export function recordingToSpawnScript(recording: SpawnRecording): MockSpawnScript {
  const normalized = normalizeSpawnRecording(recording);
  const closeEvent = findFirstEvent(normalized, 'close');
  const errorEvent = findFirstEvent(normalized, 'error');

  return {
    stdout: collectChunks(normalized, 'stdout'),
    stderr: collectChunks(normalized, 'stderr'),
    close: closeEvent
      ? {
          delayMs: closeEvent.timestamp,
          code: closeEvent.code ?? null,
          signal: closeEvent.signal ?? null,
        }
      : null,
    error: errorEvent
      ? {
          delayMs: errorEvent.timestamp,
          error: toReplayError(errorEvent) ?? new Error('recorded process error'),
        }
      : null,
  };
}

export function recordingToDurableScript(recording: SpawnRecording): MockDurableScript {
  const normalized = normalizeSpawnRecording(recording);
  const closeEvent = findFirstEvent(normalized, 'close');
  const errorEvent = findFirstEvent(normalized, 'error');

  return {
    stdout: collectChunks(normalized, 'stdout'),
    stderr: collectChunks(normalized, 'stderr'),
    exit: closeEvent
      ? {
          delayMs: closeEvent.timestamp,
          exitCode: closeEvent.code ?? null,
          signal: closeEvent.signal ?? null,
        }
      : errorEvent
        ? {
            delayMs: errorEvent.timestamp,
            exitCode: null,
            signal: null,
          }
        : null,
    waitForExitError: closeEvent ? undefined : (toReplayError(errorEvent) ?? undefined),
  };
}

export type { SpawnRecording } from '../../src/infra/spawn-recording.js';
