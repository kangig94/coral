import type { Server as NetServer, Socket } from 'node:net';

import { withValidatedHandoffTarget } from '../../infra/handoff-target.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import { revalidateUpgradeIntentTarget, type UpgradeIntent } from '../../infra/upgrade-intent.js';
import type { SuccessionAttemptPorts, SuccessionAttemptProcess } from '../../runtime/succession-attempt.js';
import type { CommittedSuccessionServing } from '../../store/succession-writer-generation.js';
import { attachInheritedIpcServer, enableInheritedIpcCleanup, type IpcListener } from '../../transport/ipc/server.js';
import type { SuccessionPreparation } from './protocol.js';

export type AttemptAcknowledgment =
  | Readonly<{ kind: 'ready'; epochKey: string; receiptIds: readonly string[] }>
  | Readonly<{
      kind: 'serving';
      epochKey: string;
      controlGeneration: number;
      successorInstanceId: string;
    }>
  | Readonly<{ kind: 'hold'; reason: string }>;

type AttemptMessage =
  | { kind: 'child-online'; attemptId: string }
  | {
      kind: 'start';
      attemptId: string;
      bootToken: string;
      socketPaths: string[];
      epochKey: string;
      receiptIds: string[];
      recovery: boolean;
    }
  | { kind: 'listener-ready'; attemptId: string }
  | { kind: 'listener'; attemptId: string; socketPath: string }
  | { kind: 'listener-accepted'; attemptId: string; socketPath: string }
  | { kind: 'listeners-complete'; attemptId: string }
  | { kind: 'listeners-accepted'; attemptId: string }
  | { kind: 'connection'; attemptId: string; socketPath: string; pendingFrameBase64: string }
  | { kind: 'deadline'; attemptId: string; at: number }
  | { kind: 'writers-parked'; attemptId: string }
  | { kind: 'abort'; attemptId: string }
  | { kind: 'ack'; attemptId: string; acknowledgment: AttemptAcknowledgment };

function isAttemptMessage(value: unknown): value is AttemptMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'attemptId' in value &&
    typeof value.kind === 'string' &&
    typeof value.attemptId === 'string'
  );
}

function listeningClaim(listener: IpcListener): { socketPath: string; server: NetServer; listener: IpcListener }[] {
  const claim = [listener, ...(listener.compatibilityListeners ?? [])];
  return claim.map((entry) => {
    const server = entry.inheritedServer ?? entry.server;
    if (entry.socketPath === null || !server.listening) {
      throw new Error('Succession requires every claimed IPC address to remain listening');
    }
    return { socketPath: entry.socketPath, server, listener: entry };
  });
}

export type SuccessionAttempt = Readonly<{
  attemptId: string;
  child: SuccessionAttemptProcess;
  childIdentity: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
  transferListeners(listener: IpcListener): Promise<void>;
  forwardConnections(listener: IpcListener): () => void;
  drainIncumbentConnections(listener: IpcListener): Promise<void>;
  setDeadline(at: number): Promise<void>;
  allowCommittedOpen(): Promise<void>;
  abort(): Promise<void>;
  onAcknowledgment(listener: (acknowledgment: AttemptAcknowledgment) => void): () => void;
}>;

export async function startSuccessionAttempt(options: {
  ports: SuccessionAttemptPorts;
  intent: UpgradeIntent;
  preparation: SuccessionPreparation;
  listener: IpcListener;
  bootToken: string;
  recoveryBundleDir?: string;
}): Promise<SuccessionAttempt> {
  const { ports, intent, preparation, listener, bootToken, recoveryBundleDir } = options;
  if (intent.attemptId !== preparation.attemptId || intent.attemptOwner?.kind !== 'incumbent') {
    throw new Error('Succession launch requires the incumbent-owned prepared attempt');
  }
  let bundleDir = recoveryBundleDir;
  if (bundleDir === undefined) {
    const target = revalidateUpgradeIntentTarget(intent);
    if (target.kind !== 'validated') throw new Error('Succession target changed before launch');
    const execution = withValidatedHandoffTarget(target.target);
    execution.assertExecutable();
    bundleDir = execution.bundleDir;
  }
  void listeningClaim(listener);
  const attemptId = preparation.attemptId;
  const child = ports.spawn(bundleDir, attemptId);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  try {
    return await createSuccessionAttemptChannel(
      ports,
      child,
      attemptId,
      listener,
      bootToken,
      preparation,
      recoveryBundleDir !== undefined,
    );
  } catch (error: unknown) {
    child.kill();
    throw error;
  }
}

export async function createSuccessionAttemptChannel(
  ports: SuccessionAttemptPorts,
  child: SuccessionAttemptProcess,
  attemptId: string,
  listener: IpcListener,
  bootToken: string,
  preparation: Pick<SuccessionPreparation, 'epochKey' | 'receipts'>,
  recovery = false,
): Promise<SuccessionAttempt> {
  const claim = listeningClaim(listener);
  const pid = child.pid;
  if (pid === undefined) throw new Error('Succession attempt child has no process identity');
  let incarnation: ProcessIncarnation | null = null;
  for (let retry = 0; retry < 5 && incarnation === null; retry++) {
    incarnation = ports.processIncarnation(pid);
    if (incarnation === null) await ports.time.sleep(20);
  }
  if (incarnation === null) {
    child.kill();
    throw new Error('Succession attempt child incarnation could not be recorded');
  }
  const received = new Set<string>();
  const observed = new Set<string>();
  const acknowledgments = new Set<(acknowledgment: AttemptAcknowledgment) => void>();
  const observedAcknowledgments = new Map<AttemptAcknowledgment['kind'], AttemptAcknowledgment>();
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let ended = false;
  let transferred = false;
  const fail = (reason: string): void => {
    ended = true;
    for (const waiter of waiters.values()) waiter.reject(new Error(reason));
    waiters.clear();
  };
  child.on('exit', () => fail('Succession attempt child exited before listener handover completed'));
  child.on('disconnect', () => fail('Succession attempt channel disconnected'));
  child.on('message', (message: unknown) => {
    if (!isAttemptMessage(message) || message.attemptId !== attemptId) return;
    if (message.kind === 'listener-accepted') received.add(message.socketPath);
    if (message.kind === 'ack') {
      observedAcknowledgments.set(message.acknowledgment.kind, message.acknowledgment);
      for (const callback of acknowledgments) callback(message.acknowledgment);
    }
    const key = message.kind === 'listener-accepted' ? `${message.kind}:${message.socketPath}` : message.kind;
    observed.add(key);
    const waiter = waiters.get(key);
    if (waiter !== undefined) {
      waiters.delete(key);
      waiter.resolve();
    }
  });
  const waitFor = (key: string): Promise<void> => {
    if (ended) return Promise.reject(new Error('Succession attempt child is gone'));
    if (observed.has(key)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => waiters.set(key, { resolve, reject }));
  };
  const send = (message: AttemptMessage, handle?: NetServer | Socket): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (ended || !child.connected) {
        reject(new Error('Succession attempt channel is unavailable'));
        return;
      }
      child.send(message, handle, (error) => (error ? reject(error) : resolve()));
    });

  let onlineDeadline: ReturnType<SuccessionAttemptPorts['time']['setTimeout']> | null = null;
  try {
    await Promise.race([
      waitFor('child-online'),
      new Promise<void>((_, reject) => {
        onlineDeadline = ports.time.setTimeout(
          () => reject(new Error('Succession attempt child did not open its private channel')),
          10_000,
        );
      }),
    ]);
  } finally {
    ports.time.clearTimeout(onlineDeadline);
  }
  await send({
    kind: 'start',
    attemptId,
    bootToken,
    socketPaths: claim.map((entry) => entry.socketPath),
    epochKey: preparation.epochKey,
    receiptIds: preparation.receipts.map((receipt) => receipt.receiptId),
    recovery,
  });

  return {
    attemptId,
    child,
    childIdentity: { pid, incarnation },
    transferListeners: async (current) => {
      const currentClaim = listeningClaim(current);
      if (
        currentClaim.length !== claim.length ||
        currentClaim.some((entry, index) => entry.socketPath !== claim[index]?.socketPath)
      ) {
        throw new Error('IPC address claim changed after succession attempt launch');
      }
      await waitFor('listener-ready');
      for (const entry of currentClaim) {
        const accepted = waitFor(`listener-accepted:${entry.socketPath}`);
        await send({ kind: 'listener', attemptId, socketPath: entry.socketPath }, entry.server);
        await accepted;
      }
      const accepted = waitFor('listeners-accepted');
      await send({ kind: 'listeners-complete', attemptId });
      await accepted;
      if (received.size !== currentClaim.length) throw new Error('Incomplete IPC listener transfer');
      transferred = true;
    },
    forwardConnections: (current) => {
      if (!transferred) throw new Error('IPC listeners must transfer before overlap forwarding');
      const entries = listeningClaim(current);
      if (entries.some((entry) => entry.listener.forwardConnections === undefined)) {
        throw new Error('IPC listener cannot forward overlap connections');
      }
      const stops = entries.map((entry) => {
        const forward = entry.listener.forwardConnections;
        if (forward === undefined) throw new Error('IPC listener cannot forward overlap connections');
        return forward((socket, pendingFrameBase64) => {
          void send({ kind: 'connection', attemptId, socketPath: entry.socketPath, pendingFrameBase64 }, socket).catch(
            () => socket.destroy(),
          );
        });
      });
      return () => stops.forEach((stop) => stop());
    },
    drainIncumbentConnections: async (current) => {
      await Promise.all(
        listeningClaim(current).map((entry) => {
          const drain = entry.listener.drainConnections;
          if (drain === undefined) throw new Error('IPC listener cannot drain open connections');
          return drain();
        }),
      );
    },
    setDeadline: (at) => send({ kind: 'deadline', attemptId, at }),
    allowCommittedOpen: () => send({ kind: 'writers-parked', attemptId }),
    abort: () => send({ kind: 'abort', attemptId }),
    onAcknowledgment: (callback) => {
      acknowledgments.add(callback);
      for (const acknowledgment of observedAcknowledgments.values()) callback(acknowledgment);
      return () => {
        acknowledgments.delete(callback);
      };
    },
  };
}

export type SuccessionAttemptChild = Readonly<{
  attemptId: string;
  bootToken: string;
  epochKey: string;
  receiptIds: readonly string[];
  recovery: boolean;
  adoptListeners(listener: IpcListener): Promise<void>;
  acknowledge(acknowledgment: AttemptAcknowledgment): Promise<void>;
  waitForWritersParked(): Promise<void>;
  waitForServing(): Promise<void>;
  isServing(): boolean;
  markServing(listener: IpcListener, commit: CommittedSuccessionServing): void;
}>;

let activeAttemptChild: SuccessionAttemptChild | null = null;

export function installSuccessionAttemptChild(child: SuccessionAttemptChild | null): void {
  activeAttemptChild = child;
}

export function currentSuccessionAttemptChild(): SuccessionAttemptChild | null {
  return activeAttemptChild;
}

export async function receiveSuccessionAttemptChild(
  ports: SuccessionAttemptPorts,
): Promise<SuccessionAttemptChild | null> {
  const attemptId = ports.env('CORAL_SUCCESSION_ATTEMPT_ID');
  if (attemptId === undefined) return null;
  if (!ports.channel.available) {
    throw new Error('Succession attempt requires its private spawn channel');
  }
  let startResolve: ((message: Extract<AttemptMessage, { kind: 'start' }>) => void) | null = null;
  let adoptResolve: (() => void) | null = null;
  let adoptReject: ((error: Error) => void) | null = null;
  let listener: IpcListener | null = null;
  let socketPaths: string[] = [];
  const adopted = new Map<string, IpcListener>();
  let serving = false;
  let parkedResolve: (() => void) | null = null;
  const parkedPromise = new Promise<void>((resolve) => {
    parkedResolve = resolve;
  });
  let servingListener: IpcListener | null = null;
  let servingResolve: (() => void) | null = null;
  const servingPromise = new Promise<void>((resolve) => {
    servingResolve = resolve;
  });
  let deadlineTimer: ReturnType<SuccessionAttemptPorts['time']['setTimeout']> | null = null;
  const pendingConnections: { socket: Socket; socketPath: string; pendingFrameBase64: string }[] = [];
  const stopParking: (() => void)[] = [];
  const send = (message: AttemptMessage): void => {
    ports.channel.send(message);
  };
  const online = ports.time.setInterval(() => send({ kind: 'child-online', attemptId }), 100);
  online.unref?.();
  const fail = (reason: string): void => {
    adoptReject?.(new Error(reason));
    ports.channel.fail(serving);
  };
  ports.channel.on('disconnect', () => {
    if (!serving) fail('Succession attempt lost its incumbent channel before serving');
    else if (servingListener !== null) enableInheritedIpcCleanup(servingListener);
  });
  ports.channel.on('message', (message: unknown, handle: unknown) => {
    if (!isAttemptMessage(message) || message.attemptId !== attemptId) return;
    if (
      message.kind === 'start' &&
      Array.isArray(message.socketPaths) &&
      typeof message.bootToken === 'string' &&
      typeof message.epochKey === 'string' &&
      Array.isArray(message.receiptIds) &&
      typeof message.recovery === 'boolean'
    ) {
      ports.time.clearInterval(online);
      startResolve?.(message);
      return;
    }
    if (message.kind === 'abort' && !serving) {
      fail('Succession attempt aborted');
      return;
    }
    if (message.kind === 'deadline' && !serving && Number.isFinite(message.at)) {
      ports.time.clearTimeout(deadlineTimer);
      deadlineTimer = ports.time.setTimeout(
        () => fail('Succession attempt exceeded its commit deadline'),
        Math.max(0, message.at - ports.time.now()),
      );
      return;
    }
    if (message.kind === 'writers-parked' && !serving) {
      parkedResolve?.();
      return;
    }
    if (message.kind === 'listener' && listener !== null && handle !== undefined) {
      if (!socketPaths.includes(message.socketPath) || adopted.has(message.socketPath)) {
        fail('Succession attempt received an unclaimed IPC listener');
        return;
      }
      const next = adopted.size === 0 ? listener : listener.createCompatibilityListener?.();
      if (next === undefined) {
        fail('Succession attempt cannot adopt compatibility listener');
        return;
      }
      if (next !== listener) listener.compatibilityListeners?.push(next);
      const stop = next.forwardConnections?.((socket, pendingFrameBase64) => {
        pendingConnections.push({ socket, socketPath: message.socketPath, pendingFrameBase64 });
      });
      if (stop !== undefined) stopParking.push(stop);
      attachInheritedIpcServer(next, handle as NetServer, message.socketPath);
      adopted.set(message.socketPath, next);
      send({ kind: 'listener-accepted', attemptId, socketPath: message.socketPath });
      return;
    }
    if (message.kind === 'listeners-complete' && adopted.size === socketPaths.length) {
      send({ kind: 'listeners-accepted', attemptId });
      adoptResolve?.();
      return;
    }
    if (message.kind === 'connection' && handle !== undefined && adopted.has(message.socketPath)) {
      const socket = handle as Socket;
      socket.pause();
      if (serving) adopted.get(message.socketPath)?.acceptSocket?.(socket, message.pendingFrameBase64);
      else
        pendingConnections.push({
          socket,
          socketPath: message.socketPath,
          pendingFrameBase64: message.pendingFrameBase64,
        });
    }
  });
  send({ kind: 'child-online', attemptId });
  const start = await new Promise<Extract<AttemptMessage, { kind: 'start' }>>((resolve) => {
    startResolve = resolve;
  });
  socketPaths = start.socketPaths;
  return {
    attemptId,
    bootToken: start.bootToken,
    epochKey: start.epochKey,
    receiptIds: start.receiptIds,
    recovery: start.recovery === true,
    adoptListeners: async (current) => {
      listener = current;
      const completion = new Promise<void>((resolve, reject) => {
        adoptResolve = resolve;
        adoptReject = reject;
      });
      send({ kind: 'listener-ready', attemptId });
      await completion;
    },
    acknowledge: (acknowledgment) =>
      new Promise<void>((resolve, reject) => {
        if (
          acknowledgment.kind === 'serving' &&
          ports.env('NODE_ENV') === 'test' &&
          ports.env('CORAL_TEST_SUCCESSION_DROP_SERVING_ACK') === '1'
        ) {
          resolve();
          return;
        }
        if (!ports.channel.connected) {
          reject(new Error('Succession attempt channel is unavailable'));
          return;
        }
        ports.channel.send({ kind: 'ack', attemptId, acknowledgment }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    waitForWritersParked: () => parkedPromise,
    waitForServing: () => servingPromise,
    isServing: () => serving,
    markServing: (current, commit) => {
      if (commit.attemptId !== attemptId) throw new Error('Succession serving record names another attempt');
      if (adopted.size !== socketPaths.length) throw new Error('Succession cannot serve an incomplete IPC claim');
      ports.time.clearTimeout(deadlineTimer);
      serving = true;
      servingListener = current;
      servingResolve?.();
      for (const stop of stopParking.splice(0)) stop();
      for (const connection of pendingConnections.splice(0)) {
        adopted.get(connection.socketPath)?.acceptSocket?.(connection.socket, connection.pendingFrameBase64);
      }
    },
  };
}
