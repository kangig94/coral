import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';

import {
  observeProcessLiveness,
  probeProcessIncarnation,
  type ProcessIncarnation,
  type ProcessLiveness,
} from '../infra/node-process.js';
import type { TimePort } from '../infra/port-types.js';

/** The I/O of an upgrade waiter and of the contender that starts one. */
export interface UpgradeWaiterPorts {
  readonly time: Pick<TimePort, 'now' | 'sleep'>;
  readonly pid: number;
  uuid(): string;
  processIncarnation(pid: number): ProcessIncarnation | null;
  processLiveness(pid: number): ProcessLiveness;
  /** Only a missing path proves absence; a path that could not be observed is not absent. */
  pathAbsent(path: string): boolean;
  /**
   * Starts `entryPoint` under this Node binary as a detached, unreferenced process that outlives its launcher,
   * with this process's environment plus `env`. Resolves its pid once spawned, or null when it never started.
   */
  launchDetached(
    entryPoint: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): Promise<number | null>;
}

export function createRealUpgradeWaiterPorts(): UpgradeWaiterPorts {
  return {
    // A waiter process has nothing else holding its event loop, so its poll sleep must keep the process alive.
    time: { now: () => Date.now(), sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) },
    pid: process.pid,
    uuid: () => randomUUID(),
    processIncarnation: (pid) => probeProcessIncarnation(pid),
    processLiveness: (pid) => observeProcessLiveness(pid),
    pathAbsent: (path) => {
      try {
        lstatSync(path);
        return false;
      } catch (error: unknown) {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT';
      }
    },
    launchDetached: (entryPoint, args, env) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [entryPoint, ...args], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...env },
        });
        child.once('error', () => resolve(null));
        child.once('spawn', () => {
          child.unref();
          resolve(child.pid ?? null);
        });
      }),
  };
}
