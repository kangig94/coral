import { type ChildProcess, type SendHandle } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import { probeProcessIncarnation, type ProcessIncarnation } from '../infra/node-process.js';
import { createRealTimePort } from '../infra/time.js';
import type { TimePort } from '../infra/port-types.js';

export type SuccessionAttemptProcess = ChildProcess & { coordinatorPid?: Promise<number> };

let replacementSupervisor: ChildProcess | null = null;

export function installReplacementSupervisorChannel(supervisor: ChildProcess): void {
  replacementSupervisor = supervisor;
  supervisor.once('disconnect', () => {
    if (replacementSupervisor === supervisor) replacementSupervisor = null;
  });
}

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

function requestSupervisedAttempt(bundleDir: string, attemptId: string): SuccessionAttemptProcess {
  const supervisor = (replacementSupervisor?.connected ? replacementSupervisor : process) as ChildProcess;
  const processView = new EventEmitter() as SuccessionAttemptProcess;
  let pid: number | undefined;
  let connected = true;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let resolvePid!: (value: number) => void;
  let rejectPid!: (error: Error) => void;
  const coordinatorPid = new Promise<number>((resolve, reject) => {
    resolvePid = resolve;
    rejectPid = reject;
  });
  Object.defineProperties(processView, {
    pid: { get: () => pid },
    connected: { get: () => connected && supervisor.connected },
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
    coordinatorPid: { value: coordinatorPid },
    send: {
      value: (
        message: unknown,
        handle?: SendHandle | ((error: Error | null) => void),
        callback?: (error: Error | null) => void,
      ) => {
        const sentHandle = typeof handle === 'function' ? undefined : handle;
        const done = typeof handle === 'function' ? handle : callback;
        supervisor.send?.({ kind: 'coral-supervisor-relay', attemptId, message }, sentHandle, done);
        return true;
      },
    },
    kill: {
      value: (signal?: NodeJS.Signals) => {
        supervisor.send?.({ kind: 'coral-supervisor-retire-attempt', attemptId, signal });
        return true;
      },
    },
  });
  const onMessage = (message: unknown, handle: unknown): void => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('kind' in message) ||
      !('attemptId' in message) ||
      message.attemptId !== attemptId
    )
      return;
    switch (message.kind) {
      case 'coral-supervisor-attempt-spawned':
        if ('pid' in message && typeof message.pid === 'number') {
          pid = message.pid;
          resolvePid(pid);
          processView.emit('spawn');
        }
        break;
      case 'coral-supervisor-attempt-message':
        processView.emit('message', 'message' in message ? message.message : undefined, handle);
        break;
      case 'coral-supervisor-attempt-exit':
        connected = false;
        exitCode = 'exitCode' in message && typeof message.exitCode === 'number' ? message.exitCode : null;
        signalCode =
          'signal' in message && typeof message.signal === 'string' ? (message.signal as NodeJS.Signals) : null;
        supervisor.off('message', onMessage);
        processView.emit('exit', exitCode, signalCode);
        processView.emit('disconnect');
        break;
      case 'coral-supervisor-attempt-error': {
        const error = new Error('reason' in message ? String(message.reason) : 'Supervisor refused succession launch');
        rejectPid(error);
        processView.emit('error', error);
        break;
      }
    }
  };
  supervisor.on('message', onMessage);
  supervisor.send?.({ kind: 'coral-supervisor-start-attempt', attemptId, bundleDir });
  return processView;
}

export function createRealSuccessionAttemptPorts(): SuccessionAttemptPorts {
  let upstreamConnected = true;
  return {
    time: createRealTimePort(),
    spawn: (bundleDir, attemptId) => {
      if (
        process.env.CORAL_LAUNCH_ADMISSION !== '1' ||
        (replacementSupervisor?.connected !== true && !process.connected)
      )
        throw new Error('Succession launch requires a namespace supervisor channel');
      return requestSupervisedAttempt(bundleDir, attemptId);
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
