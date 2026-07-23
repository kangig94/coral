import { spawn, type ChildProcess } from 'node:child_process';

import type {
  StoreResetDiagnosticChild,
  StoreResetDiagnosticSupervisorPort,
} from '#src/store/reset-incident-diagnostic.js';

function asBytes(chunk: Uint8Array | string): Uint8Array {
  return typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}

function adaptChild(child: ChildProcess): StoreResetDiagnosticChild {
  const stdoutListeners: Array<(chunk: Uint8Array) => void> = [];
  const stderrListeners: Array<(chunk: Uint8Array) => void> = [];
  const closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorListeners: Array<() => void> = [];

  const stdoutHandler = (chunk: Uint8Array | string): void => {
    const bytes = asBytes(chunk);
    for (const listener of stdoutListeners) listener(bytes);
  };
  const stderrHandler = (chunk: Uint8Array | string): void => {
    const bytes = asBytes(chunk);
    for (const listener of stderrListeners) listener(bytes);
  };
  const closeHandler = (code: number | null, signal: NodeJS.Signals | null): void => {
    for (const listener of closeListeners) listener(code, signal);
  };
  const errorHandler = (): void => {
    for (const listener of errorListeners) listener();
  };

  child.stdout?.on('data', stdoutHandler);
  child.stderr?.on('data', stderrHandler);
  child.on('close', closeHandler);
  child.on('error', errorHandler);

  return {
    onStdout(listener) {
      stdoutListeners.push(listener);
    },
    onStderr(listener) {
      stderrListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    terminate(force) {
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // The bounded supervisor advances to the next deadline independently.
      }
    },
    destroyPipes() {
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    dispose() {
      child.stdout?.off('data', stdoutHandler);
      child.stderr?.off('data', stderrHandler);
      child.off('close', closeHandler);
      child.off('error', errorHandler);
      stdoutListeners.length = 0;
      stderrListeners.length = 0;
      closeListeners.length = 0;
      errorListeners.length = 0;
    },
    unref() {
      child.unref();
    },
  };
}

export function createNodeStoreResetDiagnosticSupervisor(): StoreResetDiagnosticSupervisorPort {
  return {
    spawn(executable, args) {
      return adaptChild(
        spawn(executable, [...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }),
      );
    },
    setTimeout(callback, milliseconds) {
      return setTimeout(callback, milliseconds);
    },
    clearTimeout(handle) {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };
}
