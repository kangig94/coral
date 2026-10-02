import type { Server as NetServer, Socket } from 'node:net';

import { closeHandle } from '../../infra/ipc-handle.js';
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
  | { kind: 'release-request'; attemptId: string }
  | { kind: 'release-ready'; attemptId: string }
  | { kind: 'connections-released'; attemptId: string }
  | { kind: 'ack'; attemptId: string; acknowledgment: AttemptAcknowledgment };

const CONNECTION_RELEASE_TIMEOUT_MS = 2_000;

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
  drainIncumbentConnections(listener: IpcListener, timeoutMs?: number): Promise<void>;
  setDeadline(at: number): Promise<void>;
  allowCommittedOpen(): Promise<void>;
  abort(): Promise<void>;
  onAcknowledgment(listener: (acknowledgment: AttemptAcknowledgment) => void): () => void;
}>;

function retireAttemptChild(child: SuccessionAttemptProcess): void {
  if (child.coordinatorPid === undefined) child.kill();
  else if (child.connected) child.send({ kind: 'coral-sentinel-retire-child' }, () => {});
}

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
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const [, coordinatorPid] = await Promise.all([spawned, child.coordinatorPid ?? spawned.then(() => child.pid)]);

  try {
    return await createSuccessionAttemptChannel(
      ports,
      child,
      attemptId,
      listener,
      bootToken,
      preparation,
      recoveryBundleDir !== undefined,
      coordinatorPid,
    );
  } catch (error: unknown) {
    retireAttemptChild(child);
    throw error;
  }
}

type AttemptChannelControlsState = {
  ports: SuccessionAttemptPorts;
  child: SuccessionAttemptProcess;
  attemptId: string;
  pid: number;
  incarnation: ProcessIncarnation;
  claim: ReturnType<typeof listeningClaim>;
  received: Set<string>;
  acknowledgments: Set<(acknowledgment: AttemptAcknowledgment) => void>;
  observedAcknowledgments: Map<AttemptAcknowledgment['kind'], AttemptAcknowledgment>;
  forwardedSends: Set<Promise<void>>;
  forwardedSockets: Set<Socket>;
  channelState: {
    transferred: boolean;
    releaseRequested: boolean;
    stopForwarding: (() => void) | null;
  };
  waitFor: (key: string) => Promise<void>;
  send: (message: AttemptMessage, handle?: NetServer | Socket) => Promise<void>;
};

function createSuccessionAttemptControls(state: AttemptChannelControlsState): SuccessionAttempt {
  const {
    ports,
    child,
    attemptId,
    pid,
    incarnation,
    claim,
    received,
    acknowledgments,
    observedAcknowledgments,
    forwardedSends,
    forwardedSockets,
    channelState,
    waitFor,
    send,
  } = state;
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
      channelState.transferred = true;
    },
    forwardConnections: (current) => {
      if (channelState.releaseRequested) throw new Error('Succession attempt ended before overlap forwarding');
      if (!channelState.transferred) throw new Error('IPC listeners must transfer before overlap forwarding');
      const entries = listeningClaim(current);
      if (entries.some((entry) => entry.listener.forwardConnections === undefined)) {
        throw new Error('IPC listener cannot forward overlap connections');
      }
      const stops = entries.map((entry) => {
        const forward = entry.listener.forwardConnections;
        if (forward === undefined) throw new Error('IPC listener cannot forward overlap connections');
        return forward((socket, pendingFrameBase64) => {
          forwardedSockets.add(socket);
          const transfer = send(
            { kind: 'connection', attemptId, socketPath: entry.socketPath, pendingFrameBase64 },
            socket,
          )
            .catch(() => {
              socket.destroy();
            })
            .finally(() => {
              forwardedSockets.delete(socket);
              forwardedSends.delete(transfer);
            });
          forwardedSends.add(transfer);
        });
      });
      channelState.stopForwarding = () => {
        for (const stop of stops) stop();
        channelState.stopForwarding = null;
      };
      return channelState.stopForwarding;
    },
    drainIncumbentConnections: async (current, timeoutMs) => {
      const drain = async (): Promise<void> => {
        await Promise.all(
          listeningClaim(current).map((entry) => {
            const drainConnections = entry.listener.drainConnections;
            if (drainConnections === undefined) throw new Error('IPC listener cannot drain open connections');
            return drainConnections();
          }),
        );
        while (forwardedSends.size > 0) await Promise.all(forwardedSends);
      };
      if (timeoutMs === undefined) return drain();
      const completed = await Promise.race([drain().then(() => true), ports.time.sleep(timeoutMs).then(() => false)]);
      if (!completed) for (const socket of forwardedSockets) socket.destroy();
    },
    setDeadline: (at) => send({ kind: 'deadline', attemptId, at }),
    allowCommittedOpen: () => send({ kind: 'writers-parked', attemptId }),
    abort: async () => {
      const released = waitFor('connections-released').catch(() => {});
      await send({ kind: 'abort', attemptId });
      let bound: ReturnType<SuccessionAttemptPorts['time']['setTimeout']> | null = null;
      try {
        await Promise.race([
          released,
          new Promise<void>((resolve) => {
            bound = ports.time.setTimeout(resolve, CONNECTION_RELEASE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        ports.time.clearTimeout(bound);
      }
    },
    onAcknowledgment: (callback) => {
      acknowledgments.add(callback);
      for (const acknowledgment of observedAcknowledgments.values()) callback(acknowledgment);
      return () => {
        acknowledgments.delete(callback);
      };
    },
  };
}

export async function createSuccessionAttemptChannel(
  ports: SuccessionAttemptPorts,
  child: SuccessionAttemptProcess,
  attemptId: string,
  listener: IpcListener,
  bootToken: string,
  preparation: Pick<SuccessionPreparation, 'epochKey' | 'receipts'>,
  recovery = false,
  coordinatorPid = child.pid,
): Promise<SuccessionAttempt> {
  const claim = listeningClaim(listener);
  const pid = coordinatorPid;
  if (pid === undefined) throw new Error('Succession attempt child has no process identity');
  let incarnation: ProcessIncarnation | null = null;
  for (let retry = 0; retry < 5 && incarnation === null; retry++) {
    incarnation = ports.processIncarnation(pid);
    if (incarnation === null) await ports.time.sleep(20);
  }
  if (incarnation === null) {
    retireAttemptChild(child);
    throw new Error('Succession attempt child incarnation could not be recorded');
  }
  const received = new Set<string>();
  const observed = new Set<string>();
  const acknowledgments = new Set<(acknowledgment: AttemptAcknowledgment) => void>();
  const observedAcknowledgments = new Map<AttemptAcknowledgment['kind'], AttemptAcknowledgment>();
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let ended = false;
  const channelState = {
    transferred: false,
    releaseRequested: false,
    stopForwarding: null as (() => void) | null,
  };
  const forwardedSends = new Set<Promise<void>>();
  const forwardedSockets = new Set<Socket>();
  const fail = (reason: string): void => {
    ended = true;
    for (const waiter of waiters.values()) waiter.reject(new Error(reason));
    waiters.clear();
  };
  child.on('exit', () => fail('Succession attempt child exited before listener handover completed'));
  child.on('disconnect', () => fail('Succession attempt channel disconnected'));
  child.on('message', (message: unknown, handle: unknown) => {
    if (!isAttemptMessage(message) || message.attemptId !== attemptId) {
      closeHandle(handle);
      return;
    }
    if (message.kind !== 'connection') closeHandle(handle);
    if (message.kind === 'release-request') {
      channelState.releaseRequested = true;
      channelState.stopForwarding?.();
      void send({ kind: 'release-ready', attemptId }).catch(() => {});
      return;
    }
    if (message.kind === 'connection' && handle !== undefined) {
      const socket = handle as Socket;
      const entry = claim.find((candidate) => candidate.socketPath === message.socketPath);
      if (entry?.listener.acceptSocket === undefined) socket.destroy();
      else entry.listener.acceptSocket(socket, message.pendingFrameBase64);
      return;
    }
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

  return createSuccessionAttemptControls({
    ports,
    child,
    attemptId,
    pid,
    incarnation,
    claim,
    received,
    acknowledgments,
    observedAcknowledgments,
    forwardedSends,
    forwardedSockets,
    channelState,
    waitFor,
    send,
  });
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

type ParkedConnection = { socket: Socket; socketPath: string; pendingFrameBase64: string };

type AttemptChildState = {
  startResolve: ((message: Extract<AttemptMessage, { kind: 'start' }>) => void) | null;
  adoptResolve: (() => void) | null;
  adoptReject: ((error: Error) => void) | null;
  listener: IpcListener | null;
  socketPaths: string[];
  adopted: Map<string, IpcListener>;
  serving: boolean;
  parkedResolve: (() => void) | null;
  parkedPromise: Promise<void>;
  servingListener: IpcListener | null;
  servingResolve: (() => void) | null;
  servingPromise: Promise<void>;
  deadlineTimer: ReturnType<SuccessionAttemptPorts['time']['setTimeout']> | null;
  pendingConnections: ParkedConnection[];
  stopParking: Array<() => void>;
  releasing: boolean;
  releaseReady: boolean;
  releaseTimedOut: boolean;
  returningSockets: Set<Socket>;
  returnSends: Set<Promise<void>>;
  windowOpen: boolean;
  failing: boolean;
  abortRequested: boolean;
  releaseReadyCallback: (() => void) | null;
};

function createAttemptChildReleaseControl(
  ports: SuccessionAttemptPorts,
  attemptId: string,
  state: AttemptChildState,
  send: (message: AttemptMessage) => void,
): {
  park: (connection: ParkedConnection) => void;
  finishFailure: () => Promise<void>;
  fail: (reason: string) => void;
} {
  const returnConnection = (connection: ParkedConnection): Promise<void> => {
    const returned = new Promise<void>((resolve) => {
      const { socket, ...addressed } = connection;
      const finish = (error: Error | null): void => {
        if (error !== null) socket.destroy();
        resolve();
      };
      try {
        ports.channel.sendHandle({ kind: 'connection', attemptId, ...addressed }, socket, finish);
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    state.returningSockets.add(connection.socket);
    state.returnSends.add(returned);
    void returned.then(() => {
      state.returningSockets.delete(connection.socket);
      state.returnSends.delete(returned);
    });
    return returned;
  };
  const park = (connection: ParkedConnection): void => {
    if (state.releaseTimedOut) connection.socket.destroy();
    else if (!state.windowOpen || (state.releasing && state.releaseReady)) void returnConnection(connection);
    else state.pendingConnections.push(connection);
  };
  const finishFailure = async (): Promise<void> => {
    for (const connection of state.pendingConnections.splice(0)) void returnConnection(connection);
    const drained = async (): Promise<boolean> => {
      while (state.returnSends.size > 0) await Promise.all(state.returnSends);
      return true;
    };
    const completed = await Promise.race([
      drained(),
      ports.time.sleep(CONNECTION_RELEASE_TIMEOUT_MS).then(() => false),
    ]);
    if (!completed) {
      state.releaseTimedOut = true;
      for (const socket of state.returningSockets) socket.destroy();
    }
    if (state.abortRequested) {
      if (!ports.channel.connected) ports.channel.fail(false);
      else {
        try {
          ports.channel.send({ kind: 'connections-released', attemptId }, () => ports.channel.fail(false));
        } catch {
          ports.channel.fail(false);
        }
      }
    } else {
      ports.channel.fail(false);
    }
  };
  const fail = (reason: string): void => {
    state.adoptReject?.(new Error(reason));
    if (state.failing) return;
    state.failing = true;
    state.releasing = true;
    ports.time.clearTimeout(state.deadlineTimer);
    if (state.serving || !ports.channel.connected) {
      ports.channel.fail(state.serving);
      return;
    }
    if (state.releaseReady || !state.windowOpen) {
      void finishFailure();
      return;
    }
    send({ kind: 'release-request', attemptId });
    const releaseTimeout = ports.time.setTimeout(() => {
      state.releaseReadyCallback = null;
      state.releaseTimedOut = true;
      for (const connection of state.pendingConnections.splice(0)) connection.socket.destroy();
      for (const socket of state.returningSockets) socket.destroy();
      ports.channel.fail(false);
    }, CONNECTION_RELEASE_TIMEOUT_MS);
    const onReleaseReady = (): void => {
      ports.time.clearTimeout(releaseTimeout);
      state.releaseReady = true;
      void finishFailure();
    };
    state.releaseReadyCallback = onReleaseReady;
  };
  return { park, finishFailure, fail };
}

function handleAttemptChildMessage(
  ports: SuccessionAttemptPorts,
  attemptId: string,
  state: AttemptChildState,
  online: ReturnType<SuccessionAttemptPorts['time']['setInterval']>,
  park: (connection: ParkedConnection) => void,
  send: (message: AttemptMessage) => void,
  fail: (reason: string) => void,
  finishFailure: () => Promise<void>,
  message: unknown,
  handle: unknown,
): void {
  if (!isAttemptMessage(message) || message.attemptId !== attemptId) {
    closeHandle(handle);
    return;
  }
  if (message.kind !== 'listener' && message.kind !== 'connection') closeHandle(handle);
  if (message.kind === 'release-ready' && state.releasing && !state.releaseTimedOut) {
    state.releaseReadyCallback?.();
    state.releaseReadyCallback = null;
    return;
  }
  if (
    message.kind === 'start' &&
    Array.isArray(message.socketPaths) &&
    typeof message.bootToken === 'string' &&
    typeof message.epochKey === 'string' &&
    Array.isArray(message.receiptIds) &&
    typeof message.recovery === 'boolean'
  ) {
    ports.time.clearInterval(online);
    state.startResolve?.(message);
    return;
  }
  if (message.kind === 'abort' && !state.serving) {
    state.abortRequested = true;
    if (state.failing) return;
    state.failing = true;
    state.releasing = true;
    state.releaseReady = true;
    ports.time.clearTimeout(state.deadlineTimer);
    state.adoptReject?.(new Error('Succession attempt aborted'));
    void finishFailure();
    return;
  }
  if (message.kind === 'deadline' && !state.serving && Number.isFinite(message.at)) {
    state.windowOpen = true;
    ports.time.clearTimeout(state.deadlineTimer);
    state.deadlineTimer = ports.time.setTimeout(
      () => fail('Succession attempt exceeded its commit deadline'),
      Math.max(0, message.at - ports.time.now()),
    );
    return;
  }
  if (message.kind === 'writers-parked' && !state.serving) {
    state.parkedResolve?.();
    return;
  }
  if (message.kind === 'listener' && state.listener !== null && handle !== undefined) {
    if (!state.socketPaths.includes(message.socketPath) || state.adopted.has(message.socketPath)) {
      closeHandle(handle);
      fail('Succession attempt received an unclaimed IPC listener');
      return;
    }
    const next = state.adopted.size === 0 ? state.listener : state.listener.createCompatibilityListener?.();
    if (next === undefined) {
      closeHandle(handle);
      fail('Succession attempt cannot adopt compatibility listener');
      return;
    }
    if (next.forwardConnections === undefined) {
      closeHandle(handle);
      fail('Succession attempt cannot park connections on an adopted listener');
      return;
    }
    if (next !== state.listener) state.listener.compatibilityListeners?.push(next);
    state.stopParking.push(
      next.forwardConnections((socket, pendingFrameBase64) => {
        park({ socket, socketPath: message.socketPath, pendingFrameBase64 });
      }),
    );
    attachInheritedIpcServer(next, handle as NetServer, message.socketPath);
    state.adopted.set(message.socketPath, next);
    send({ kind: 'listener-accepted', attemptId, socketPath: message.socketPath });
    return;
  }
  if (message.kind === 'listeners-complete' && state.adopted.size === state.socketPaths.length) {
    send({ kind: 'listeners-accepted', attemptId });
    state.adoptResolve?.();
    return;
  }

  if (message.kind === 'connection' && handle !== undefined && state.adopted.has(message.socketPath)) {
    const listener = state.adopted.get(message.socketPath);
    if (listener?.acceptSocket !== undefined) {
      listener.acceptSocket(handle as Socket, message.pendingFrameBase64);
      return;
    }
  }
  if (message.kind === 'listener' || message.kind === 'connection') closeHandle(handle);
}

export async function receiveSuccessionAttemptChild(
  ports: SuccessionAttemptPorts,
): Promise<SuccessionAttemptChild | null> {
  const attemptId = ports.env('CORAL_SUCCESSION_ATTEMPT_ID');
  if (attemptId === undefined) return null;
  if (!ports.channel.available) {
    throw new Error('Succession attempt requires its private spawn channel');
  }
  const state: AttemptChildState = {
    startResolve: null,
    adoptResolve: null,
    adoptReject: null,
    listener: null,
    socketPaths: [],
    adopted: new Map(),
    serving: false,
    parkedResolve: null,
    parkedPromise: Promise.resolve(),
    servingListener: null,
    servingResolve: null,
    servingPromise: Promise.resolve(),
    deadlineTimer: null,
    pendingConnections: [],
    stopParking: [],
    releasing: false,
    releaseReady: false,
    releaseTimedOut: false,
    returningSockets: new Set(),
    returnSends: new Set(),
    windowOpen: false,
    failing: false,
    abortRequested: false,
    releaseReadyCallback: null,
  };
  state.parkedPromise = new Promise<void>((resolve) => {
    state.parkedResolve = resolve;
  });
  state.servingPromise = new Promise<void>((resolve) => {
    state.servingResolve = resolve;
  });
  const send = (message: AttemptMessage): void => {
    ports.channel.send(message);
  };
  const { park, finishFailure, fail } = createAttemptChildReleaseControl(ports, attemptId, state, send);
  const online = ports.time.setInterval(() => send({ kind: 'child-online', attemptId }), 100);
  online.unref?.();
  ports.channel.on('disconnect', () => {
    if (!state.serving) fail('Succession attempt lost its incumbent channel before serving');
    else if (state.servingListener !== null) enableInheritedIpcCleanup(state.servingListener);
  });
  ports.channel.on('message', (message: unknown, handle: unknown) => {
    handleAttemptChildMessage(ports, attemptId, state, online, park, send, fail, finishFailure, message, handle);
  });
  send({ kind: 'child-online', attemptId });
  const start = await new Promise<Extract<AttemptMessage, { kind: 'start' }>>((resolve) => {
    state.startResolve = resolve;
  });
  state.socketPaths = start.socketPaths;
  return {
    attemptId,
    bootToken: start.bootToken,
    epochKey: start.epochKey,
    receiptIds: start.receiptIds,
    recovery: start.recovery === true,
    adoptListeners: async (current) => {
      state.listener = current;
      const completion = new Promise<void>((resolve, reject) => {
        state.adoptResolve = resolve;
        state.adoptReject = reject;
      });
      send({ kind: 'listener-ready', attemptId });
      await completion;
    },
    acknowledge: (acknowledgment) =>
      new Promise<void>((resolve, reject) => {
        if (!ports.channel.connected) {
          reject(new Error('Succession attempt channel is unavailable'));
          return;
        }
        ports.channel.send({ kind: 'ack', attemptId, acknowledgment }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    waitForWritersParked: () => state.parkedPromise,
    waitForServing: () => state.servingPromise,
    isServing: () => state.serving,
    markServing: (current, commit) => {
      if (commit.attemptId !== attemptId) throw new Error('Succession serving record names another attempt');
      if (state.adopted.size !== state.socketPaths.length)
        throw new Error('Succession cannot serve an incomplete IPC claim');
      ports.time.clearTimeout(state.deadlineTimer);
      state.serving = true;
      state.servingListener = current;
      state.servingResolve?.();
      for (const stop of state.stopParking.splice(0)) stop();
      for (const connection of state.pendingConnections.splice(0)) {
        state.adopted.get(connection.socketPath)?.acceptSocket?.(connection.socket, connection.pendingFrameBase64);
      }
    },
  };
}
