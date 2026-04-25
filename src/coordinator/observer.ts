import { join } from 'node:path';
import type { Disposable, Runtime, RuntimeObserver, SpawnEvent, SpawnListener } from '../runtime/ports.js';
import { cloneSpawnEvent } from '../runtime/spawn.js';
import {
  attachSpawnRecordingMetadata,
  buildRecordingFilePath,
  recordSpawn,
  saveRecording,
} from '../infra/process/spawn-recording.js';

export type EmittingRuntimeObserver = RuntimeObserver & {
  emit(event: SpawnEvent): void;
};

export class EventEmitterObserver implements EmittingRuntimeObserver {
  private readonly listeners = new Set<SpawnListener>();

  emit(event: SpawnEvent): void {
    const snapshot = cloneSpawnEvent(event);
    for (const listener of this.listeners) {
      listener(cloneSpawnEvent(snapshot));
    }
  }

  onSpawn(listener: SpawnListener): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

export function asEmittingRuntimeObserver(observer: RuntimeObserver): EmittingRuntimeObserver {
  if ('emit' in observer && typeof observer.emit === 'function') {
    return observer as EmittingRuntimeObserver;
  }
  throw new Error('runtimeObserver must implement emit(event) when used by createBackendServer');
}

export function observeRuntimeSpawns(runtime: Runtime, observer: EmittingRuntimeObserver): Runtime {
  const originalSpawn = runtime.process.spawn.bind(runtime.process);

  runtime.process.spawn = (options) => {
    const child = originalSpawn(options);
    observer.emit({
      child,
      command: options.command,
      args: [...options.args],
      ...(options.envAdditions ? { env: { ...options.envAdditions } } : {}),
    });
    return child;
  };

  return runtime;
}

export function resolveSpawnRecordingDir(envValue: string | undefined, cwd: string): string | null {
  if (envValue === undefined) {
    return null;
  }

  const normalized = envValue.trim();
  if (!normalized || normalized === '1' || normalized.toLowerCase() === 'true') {
    return join(cwd, '.coral-spawn-recordings');
  }

  return normalized;
}

export function attachRecordingObserver(options: {
  observer: RuntimeObserver;
  runtime: Pick<Runtime, 'storage' | 'time'>;
  recordingDir: string;
}): Disposable {
  return options.observer.onSpawn((event) => {
    attachSpawnRecordingMetadata(event.child, event);

    const recording = recordSpawn(event.child, () => options.runtime.time.now());
    const filePath = buildRecordingFilePath(options.recordingDir, event.command, options.runtime.time.now());

    let closed = false;
    let saved = false;
    const save = () => {
      if (saved) {
        return;
      }
      saved = true;
      saveRecording(options.runtime.storage, recording, filePath);
    };

    event.child.on('close', () => {
      closed = true;
      save();
    });

    event.child.on('error', () => {
      const timer = options.runtime.time.setTimeout(() => {
        if (!closed) {
          save();
        }
      }, 0);
      timer.unref?.();
    });
  });
}
