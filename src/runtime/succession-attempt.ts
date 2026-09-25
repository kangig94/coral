import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { createRealTimePort } from '../infra/time.js';
import type { TimePort } from '../infra/port-types.js';

export type SuccessionAttemptProcess = ChildProcess;

export interface SuccessionAttemptPorts {
  readonly time: TimePort;
  spawn(bundleDir: string, attemptId: string): SuccessionAttemptProcess;
  processIncarnation(pid: number): ProcessIncarnation | null;
  env(name: string): string | undefined;
  readonly channel: {
    readonly available: boolean;
    readonly connected: boolean;
    send(message: unknown, callback?: (error: Error | null) => void): void;
    on(event: 'disconnect', listener: () => void): void;
    on(event: 'message', listener: (message: unknown, handle: unknown) => void): void;
    fail(serving: boolean): void;
  };
}

export function createRealSuccessionAttemptPorts(): SuccessionAttemptPorts {
  return {
    time: createRealTimePort(),
    spawn: (bundleDir, attemptId) =>
      spawn(process.execPath, [join(bundleDir, 'coral-backend.cjs')], {
        cwd: process.cwd(),
        env: { ...process.env, CORAL_STARTUP_ATTEMPT_ID: attemptId, CORAL_SUCCESSION_ATTEMPT_ID: attemptId },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      }),
    processIncarnation: (pid) => probeProcessIncarnation(pid),
    env: (name) => process.env[name],
    channel: {
      get available() {
        return process.send !== undefined && process.channel !== undefined;
      },
      get connected() {
        return process.connected;
      },
      send: (message, callback) => {
        if (callback === undefined) process.send?.(message);
        else process.send?.(message, callback);
      },
      on: (event, listener) => {
        if (event === 'message') process.on('message', listener);
        else process.on('disconnect', listener);
      },
      fail: (serving) => {
        process.exitCode = 1;
        if (!serving) process.exit(1);
      },
    },
  };
}
