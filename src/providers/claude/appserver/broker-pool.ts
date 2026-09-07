import { SingleSessionController } from './controller.js';
import { ClaudeControllerCleanupHeldError } from './child-shutdown.js';
import {
  CLAUDE_BROKER_STATE_RPC_CODE,
  ClaudeBrokerRpcError,
  stripBrokerSessionKey,
  withBrokerSessionKey,
  type ClaudeBrokerNotification,
  type HostStatsParams,
  type SessionCloseParams,
  type SessionCloseResult,
  type SessionEnsureParams,
  type SessionEnsureResult,
  type SessionProbeParams,
  type SessionProbeResult,
  type TurnInterruptParams,
  type TurnInterruptResult,
  type TurnStartParams,
  type TurnStartResult,
} from './protocol.js';
import type {
  BrokerShutdownDisposition,
  BrokerShutdownHold,
  BrokerShutdownObservedAbsent,
  BrokerSessionController,
  BrokerSessionControllerOptions,
  ClaudeBrokerSession,
  ControllerShutdownDisposition,
  ControllerShutdownHold,
  ControllerShutdownSuccessor,
  ControllerShutdownSuccessorAcceptance,
  ControllerNotification,
  CreateBrokerSessionOptions,
  SingleSessionControllerOptions,
  TuiSpawnChild,
} from './session-contract.js';

const DEFAULT_STDERR_RING_LIMIT = 16_384;

type UntypedBrokerSessionOptions = BrokerSessionControllerOptions<unknown> & {
  createController?: (
    options: BrokerSessionControllerOptions<unknown> & { onUnexpectedExit?: () => void },
  ) => BrokerSessionController;
};

type ControllerEntry = {
  controller: BrokerSessionController;
  dispose: () => void;
  holdNotifications: boolean;
  pendingNotifications: ClaudeBrokerNotification[];
};

export class BrokerSessionPool implements ClaudeBrokerSession {
  readonly closed: Promise<Error | void>;

  private readonly spawnChild: unknown;
  private readonly createController: (
    options: BrokerSessionControllerOptions<unknown> & { onUnexpectedExit?: () => void },
  ) => BrokerSessionController;
  private readonly onTurnStarted: CreateBrokerSessionOptions['onTurnStarted'];
  private readonly stderrLimit: number;
  private readonly ids: CreateBrokerSessionOptions['ids'];
  private readonly monotonicNow: CreateBrokerSessionOptions['monotonicNow'];
  private readonly notificationHandlers = new Set<(notification: ClaudeBrokerNotification) => void>();
  private readonly controllers = new Map<string, ControllerEntry>();
  private readonly closingControllers = new Map<string, Promise<ControllerShutdownDisposition>>();
  private readonly heldControllerShutdowns = new Map<string, ControllerShutdownHold>();

  private resolveClosed!: (value: Error | void) => void;
  private shuttingDown = false;
  private closedResolved = false;

  constructor(options: UntypedBrokerSessionOptions) {
    this.spawnChild = options.spawnChild;
    this.createController =
      options.createController ??
      ((controllerOptions) =>
        new SingleSessionController(controllerOptions as unknown as SingleSessionControllerOptions));
    this.onTurnStarted = options.onTurnStarted;
    this.stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_RING_LIMIT;
    this.ids = options.ids;
    this.monotonicNow = options.monotonicNow;
    this.closed = new Promise<Error | void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  subscribeNotifications(handler: (notification: ClaudeBrokerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async sessionEnsure(params: SessionEnsureParams): Promise<SessionEnsureResult> {
    const brokerSessionKey = params.brokerSessionKey ?? this.ids.uuid();
    await this.settlePriorControllerShutdown(brokerSessionKey);
    let entry = this.controllers.get(brokerSessionKey);
    const generatedBrokerSessionKey = params.brokerSessionKey === undefined;
    const createdEntry = entry === undefined;

    if (!entry) {
      if (params.brokerSessionKey !== undefined && params.conversationRef === undefined) {
        throw new ClaudeBrokerRpcError(
          CLAUDE_BROKER_STATE_RPC_CODE,
          'Claude broker session is missing and cannot be recovered without a conversation reference.',
        );
      }

      entry = this.createControllerEntry(brokerSessionKey, generatedBrokerSessionKey);
    }

    try {
      const result = await entry.controller.sessionEnsure(stripBrokerSessionKey(params));
      if (createdEntry) {
        this.emitHostStats();
      }
      if (entry.holdNotifications) {
        this.releaseHeldNotificationsAfterEnsure(brokerSessionKey, entry);
      }
      return {
        ...result,
        brokerSessionKey,
      };
    } catch (error) {
      if (error instanceof ClaudeControllerCleanupHeldError) {
        entry.dispose();
        entry.pendingNotifications = [];
        this.controllers.delete(brokerSessionKey);
        const acceptance = this.acceptControllerShutdown(brokerSessionKey, error.hold);
        this.emitHostStats();
        throw new ClaudeBrokerRpcError(error.code, error.message, {
          cause: error.data,
          cleanupDisposition: error.hold.kind,
          observation: error.hold.observation,
          successor: acceptance,
          operatorExit: { kind: 'retry-session-ensure' },
        });
      }
      if (createdEntry) {
        await this.removeController(brokerSessionKey).catch(() => {});
      } else if (entry.holdNotifications) {
        entry.holdNotifications = false;
        entry.pendingNotifications = [];
      }
      throw error;
    }
  }

  async sessionProbe(params: SessionProbeParams): Promise<SessionProbeResult> {
    const entry = this.controllers.get(params.brokerSessionKey);
    if (!entry) {
      return {
        brokerSessionKey: params.brokerSessionKey,
        status: 'missing',
        bootstrapSignature: null,
        sessionId: null,
        conversationRef: null,
        activeTurnId: null,
      };
    }

    return {
      ...(await entry.controller.sessionProbe({
        conversationRef: params.conversationRef,
      })),
      brokerSessionKey: params.brokerSessionKey,
    };
  }

  async sessionClose(params: SessionCloseParams): Promise<SessionCloseResult> {
    const disposition = await this.removeController(params.brokerSessionKey);
    if (disposition.kind === 'observed-absent') {
      return {
        brokerSessionKey: params.brokerSessionKey,
        disposition: 'observed-absent',
      };
    }
    const hold = {
      brokerSessionKey: params.brokerSessionKey,
      successor: { kind: 'accepted', owner: 'broker-session-pool' } as const,
      operatorExit: { kind: 'retry-session-close' } as const,
    };
    if (disposition.kind === 'held-alive') {
      return { ...hold, disposition: 'held-alive', observation: 'alive' };
    }
    return {
      ...hold,
      disposition: 'held-unobservable',
      observation: 'unobservable',
    };
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    const entry = this.controllers.get(params.brokerSessionKey);
    if (!entry) {
      throw new ClaudeBrokerRpcError(
        CLAUDE_BROKER_STATE_RPC_CODE,
        'Claude broker session is not initialized. Call session/ensure first.',
      );
    }

    const result = await entry.controller.turnStart({
      brokerTurnId: params.brokerTurnId,
      prompt: params.prompt,
    });
    this.emitHostStats();
    return {
      ...result,
      brokerSessionKey: params.brokerSessionKey,
    };
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResult> {
    const entry = this.controllers.get(params.brokerSessionKey);
    if (!entry) {
      return {
        brokerTurnId: params.brokerTurnId,
        interrupted: false,
      };
    }

    return entry.controller.turnInterrupt({
      brokerTurnId: params.brokerTurnId,
    });
  }

  async shutdown(): Promise<BrokerShutdownDisposition> {
    this.shuttingDown = true;

    const priorHolds = [...this.heldControllerShutdowns.entries()];
    const keys = [...this.controllers.keys()];
    await Promise.all(keys.map((brokerSessionKey) => this.removeController(brokerSessionKey)));
    await Promise.all(this.closingControllers.values());

    for (const [brokerSessionKey, hold] of priorHolds) {
      if (this.heldControllerShutdowns.get(brokerSessionKey) !== hold) continue;
      const disposition = await hold.retry();
      if (disposition.kind === 'observed-absent') {
        if (this.heldControllerShutdowns.get(brokerSessionKey) === hold) {
          this.heldControllerShutdowns.delete(brokerSessionKey);
        }
      } else {
        this.acceptControllerShutdown(brokerSessionKey, disposition);
      }
    }

    const holds = [...this.heldControllerShutdowns.values()];
    if (holds.length === 0) {
      this.resolvePoolClosed();
      return { kind: 'observed-absent', observation: 'absent' };
    }

    const successor = { kind: 'accepted', owner: 'broker-session-pool' } as const;
    const operatorExit: BrokerShutdownHold['operatorExit'] = { kind: 'retry-broker-shutdown' };
    const continuation = {
      subjects: holds.flatMap((hold) => hold.subjects),
      successor,
      settled: Promise.all(holds.map((hold) => hold.settled)).then(
        (): BrokerShutdownObservedAbsent => ({
          kind: 'observed-absent',
          observation: 'absent',
        }),
      ),
      retry: () => this.shutdown(),
      operatorExit,
    };
    return holds.some((hold) => hold.kind === 'held-alive')
      ? { ...continuation, kind: 'held-alive', observation: 'alive' }
      : { ...continuation, kind: 'held-unobservable', observation: 'unobservable' };
  }

  private createControllerEntry(brokerSessionKey: string, holdNotifications: boolean): ControllerEntry {
    const controller = this.createController({
      spawnChild: this.spawnChild,
      ids: this.ids,
      monotonicNow: this.monotonicNow,
      onTurnStarted: this.onTurnStarted,
      stderrLimit: this.stderrLimit,
      onUnexpectedExit: () => {
        if (this.shuttingDown) {
          return;
        }
        void this.removeController(brokerSessionKey).catch(() => {});
      },
    });

    const entry: ControllerEntry = {
      controller,
      dispose: () => {},
      holdNotifications,
      pendingNotifications: [],
    };

    entry.dispose = controller.subscribeNotifications((notification) => {
      this.handleControllerNotification(brokerSessionKey, notification);
    });

    this.controllers.set(brokerSessionKey, entry);
    return entry;
  }

  private handleControllerNotification(brokerSessionKey: string, notification: ControllerNotification): void {
    const entry = this.controllers.get(brokerSessionKey);
    if (!entry) {
      return;
    }

    const routed = withBrokerSessionKey(brokerSessionKey, notification);
    if (entry.holdNotifications) {
      entry.pendingNotifications.push(routed);
      return;
    }

    this.dispatchControllerNotification(brokerSessionKey, entry, routed);
  }

  private evictIdleControllerAfterTerminalTurn(brokerSessionKey: string, entry: ControllerEntry): void {
    if (!entry.controller.canEvictReachableIdleController()) {
      return;
    }

    // Defer one tick so terminal notification subscribers can issue an immediate
    // follow-up against the still-reachable controller before idle eviction runs.
    setImmediate(() => {
      const currentEntry = this.controllers.get(brokerSessionKey);
      if (currentEntry !== entry || !currentEntry.controller.canEvictReachableIdleController()) {
        return;
      }
      void this.removeController(brokerSessionKey).catch(() => {});
    });
  }

  private releaseHeldNotificationsAfterEnsure(brokerSessionKey: string, entry: ControllerEntry): void {
    setImmediate(() => {
      const currentEntry = this.controllers.get(brokerSessionKey);
      if (currentEntry !== entry) {
        return;
      }

      currentEntry.holdNotifications = false;
      const queued = currentEntry.pendingNotifications;
      currentEntry.pendingNotifications = [];
      for (const notification of queued) {
        this.dispatchControllerNotification(brokerSessionKey, currentEntry, notification);
      }
    });
  }

  private dispatchControllerNotification(
    brokerSessionKey: string,
    entry: ControllerEntry,
    notification: ClaudeBrokerNotification,
  ): void {
    this.emitNotification(notification);
    if (notification.method === 'turn/completed' || notification.method === 'turn/failed') {
      this.emitHostStats();
      this.evictIdleControllerAfterTerminalTurn(brokerSessionKey, entry);
    }
  }

  private async removeController(brokerSessionKey: string): Promise<ControllerShutdownDisposition> {
    const existingClose = this.closingControllers.get(brokerSessionKey);
    if (existingClose) {
      return existingClose;
    }

    const heldShutdown = this.heldControllerShutdowns.get(brokerSessionKey);
    if (heldShutdown !== undefined) {
      const disposition = await heldShutdown.retry();
      if (disposition.kind === 'observed-absent') {
        if (this.heldControllerShutdowns.get(brokerSessionKey) === heldShutdown) {
          this.heldControllerShutdowns.delete(brokerSessionKey);
        }
      } else {
        this.acceptControllerShutdown(brokerSessionKey, disposition);
      }
      return disposition;
    }

    const entry = this.controllers.get(brokerSessionKey);
    if (!entry) {
      return { kind: 'observed-absent', observation: 'absent', subjects: [] };
    }

    entry.dispose();
    entry.pendingNotifications = [];
    this.controllers.delete(brokerSessionKey);
    const closing = entry.controller.shutdown().then((disposition) => {
      if (disposition.kind !== 'observed-absent') {
        this.acceptControllerShutdown(brokerSessionKey, disposition);
      }
      return disposition;
    });
    this.closingControllers.set(brokerSessionKey, closing);
    this.emitHostStats();
    try {
      return await closing;
    } finally {
      if (this.closingControllers.get(brokerSessionKey) === closing) {
        this.closingControllers.delete(brokerSessionKey);
        this.emitHostStats();
      }
    }
  }

  private async settlePriorControllerShutdown(brokerSessionKey: string): Promise<void> {
    const inFlight = this.closingControllers.get(brokerSessionKey);
    const priorHold = this.heldControllerShutdowns.get(brokerSessionKey);
    const disposition = inFlight !== undefined ? await inFlight : await priorHold?.retry();
    if (disposition === undefined) return;
    if (disposition.kind === 'observed-absent') {
      this.heldControllerShutdowns.delete(brokerSessionKey);
      return;
    }

    const acceptance = this.acceptControllerShutdown(brokerSessionKey, disposition);
    throw new ClaudeBrokerRpcError(
      CLAUDE_BROKER_STATE_RPC_CODE,
      'Claude broker session replacement is held until the prior child is observed absent.',
      {
        disposition: disposition.kind,
        observation: disposition.observation,
        successor: acceptance,
        operatorExit: { kind: 'retry-session-ensure' },
      },
    );
  }

  private acceptControllerShutdown(
    brokerSessionKey: string,
    hold: ControllerShutdownHold,
  ): ControllerShutdownSuccessorAcceptance {
    const successor: ControllerShutdownSuccessor = {
      owner: 'broker-session-pool',
      accept: (acceptedHold) => {
        if (acceptedHold !== hold) {
          throw new Error('Claude child shutdown transfer changed the held obligation.');
        }
        this.heldControllerShutdowns.set(brokerSessionKey, acceptedHold);
        void acceptedHold.settled.then(() => {
          if (this.heldControllerShutdowns.get(brokerSessionKey) !== acceptedHold) return;
          this.heldControllerShutdowns.delete(brokerSessionKey);
          this.emitHostStats();
        });
        return { kind: 'accepted', owner: 'broker-session-pool' };
      },
    };
    const acceptance = hold.operatorExit.transfer(successor);
    if (acceptance.kind !== 'accepted' || acceptance.owner !== 'broker-session-pool') {
      throw new Error('Claude child shutdown ownership transfer was not accepted by the broker session pool.');
    }
    return acceptance;
  }

  private emitNotification(notification: ClaudeBrokerNotification): void {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }

  private emitHostStats(): void {
    this.emitNotification({
      method: 'host/stats',
      params: this.currentHostStats(),
    });
  }

  private currentHostStats(): HostStatsParams {
    let liveControllers = 0;
    let activeTurns = 0;
    for (const entry of this.controllers.values()) {
      if (entry.controller.hasLiveController()) {
        liveControllers += 1;
      }
      if (entry.controller.hasActiveTurn()) {
        activeTurns += 1;
      }
    }
    return {
      liveControllers,
      activeTurns,
      heldControllers: new Set([...this.closingControllers.keys(), ...this.heldControllerShutdowns.keys()]).size,
    };
  }

  private resolvePoolClosed(error?: Error): void {
    if (this.closedResolved) {
      return;
    }
    this.closedResolved = true;
    this.resolveClosed(error);
  }
}

export function createBrokerSession<TSpawnChild = TuiSpawnChild>(
  options: CreateBrokerSessionOptions<TSpawnChild>,
): ClaudeBrokerSession {
  const createController = options.createController;
  return new BrokerSessionPool({
    spawnChild: options.spawnChild,
    ids: options.ids,
    monotonicNow: options.monotonicNow,
    onTurnStarted: options.onTurnStarted,
    stderrLimit: options.stderrLimit,
    ...(createController === undefined
      ? {}
      : {
          createController: (controllerOptions) =>
            createController(
              controllerOptions as BrokerSessionControllerOptions<TSpawnChild> & { onUnexpectedExit?: () => void },
            ),
        }),
  });
}
