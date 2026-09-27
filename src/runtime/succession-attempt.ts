import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';

import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { composeCoralPaths } from '../infra/path/index.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { createRealTimePort } from '../infra/time.js';
import type { TimePort } from '../infra/port-types.js';

export type SuccessionAttemptProcess = ChildProcess & { coordinatorPid?: Promise<number> };

export interface SuccessionAttemptPorts {
  readonly time: TimePort;
  spawn(bundleDir: string, attemptId: string): SuccessionAttemptProcess;
  processIncarnation(pid: number): ProcessIncarnation | null;
  env(name: string): string | undefined;
  readonly channel: {
    readonly available: boolean;
    readonly connected: boolean;
    send(message: unknown, callback?: (error: Error | null) => void): void;
    /** Sends a connection's handle; the handle is closed in this process once sent. */
    sendHandle(message: unknown, handle: Socket, callback: (error: Error | null) => void): void;
    on(event: 'disconnect', listener: () => void): void;
    on(event: 'message', listener: (message: unknown, handle: unknown) => void): void;
    fail(serving: boolean): void;
  };
}

export function createRealSuccessionAttemptPorts(): SuccessionAttemptPorts {
  let upstreamConnected = true;
  return {
    time: createRealTimePort(),
    spawn: (bundleDir, attemptId) => {
      const backend = join(bundleDir, 'coral-backend.cjs');
      const sentinel = join(bundleDir, 'coral-sentinel.cjs');
      const supervised = existsSync(sentinel);
      const child: SuccessionAttemptProcess = spawn(process.execPath, supervised ? [sentinel, backend] : [backend], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CORAL_STARTUP_ATTEMPT_ID: attemptId,
          CORAL_SUCCESSION_ATTEMPT_ID: attemptId,
          CORAL_SENTINEL_RUN_DIR: composeCoralPaths(resolveBuildFlavor(process.env)).coordinator.runDir,
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      if (supervised) {
        child.coordinatorPid = new Promise<number>((resolve, reject) => {
          const onMessage = (message: unknown): void => {
            if (
              typeof message === 'object' &&
              message !== null &&
              'kind' in message &&
              message.kind === 'coral-sentinel-child' &&
              'pid' in message &&
              typeof message.pid === 'number' &&
              Number.isSafeInteger(message.pid)
            ) {
              child.off('message', onMessage);
              resolve(message.pid);
            }
          };
          child.on('message', onMessage);
          child.once('error', reject);
          child.once('exit', () => reject(new Error('Succession sentinel exited before its coordinator spawned')));
        });
      }
      return child;
    },
    processIncarnation: (pid) => probeProcessIncarnation(pid),
    env: (name) => process.env[name],
    channel: {
      get available() {
        return process.send !== undefined && process.channel !== undefined;
      },
      get connected() {
        return process.connected && upstreamConnected;
      },
      send: (message, callback) => {
        if (callback === undefined) process.send?.(message);
        else process.send?.(message, callback);
      },
      sendHandle: (message, handle, callback) => {
        if (process.send === undefined) callback(new Error('Succession attempt channel is unavailable'));
        else process.send(message, handle, callback);
      },
      on: (event, listener) => {
        if (event === 'message') process.on('message', listener);
        else {
          process.on('disconnect', listener);
          process.on('message', (message: unknown) => {
            if (
              typeof message === 'object' &&
              message !== null &&
              'kind' in message &&
              message.kind === 'coral-sentinel-upstream-disconnected'
            ) {
              upstreamConnected = false;
              (listener as () => void)();
            }
          });
        }
      },
      fail: (serving) => {
        process.exitCode = 1;
        if (!serving) process.exit(1);
      },
    },
  };
}
