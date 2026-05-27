import { SingleSessionController } from './controller.js';
import {
  CLAUDE_BROKER_STATE_RPC_CODE,
  ClaudeBrokerRpcError,
  stripBrokerSessionKey,
  withBrokerSessionKey,
  type ClaudeBrokerNotification,
  type HostStatsParams,
  type SessionEnsureParams,
  type SessionEnsureResult,
  type SessionProbeParams,
  type SessionProbeResult,
  type TurnInterruptParams,
  type TurnInterruptResult,
  type TurnStartParams,
  type TurnStartResult,
} from './protocol.js';
import type { ClaudeBrokerSession, ControllerNotification, CreateBrokerSessionOptions } from './session-contract.js';

const DEFAULT_STDERR_RING_LIMIT = 16_384;

type ControllerEntry = {
  controller: SingleSessionController;
  dispose: () => void;
  holdNotifications: boolean;
  pendingNotifications: ClaudeBrokerNotification[];
};

export class BrokerSessionPool implements ClaudeBrokerSession {
  readonly closed: Promise<Error | void>;

  private readonly spawnChild: CreateBrokerSessionOptions['spawnChild'];
  private readonly onTurnStarted: CreateBrokerSessionOptions['onTurnStarted'];
  private readonly stderrLimit: number;
  private readonly ids: CreateBrokerSessionOptions['ids'];
  private readonly notificationHandlers = new Set<(notification: ClaudeBrokerNotification) => void>();
  private readonly controllers = new Map<string, ControllerEntry>();

  private resolveClosed!: (value: Error | void) => void;
  private shuttingDown = false;
  private closedResolved = false;

  constructor(options: CreateBrokerSessionOptions) {
    this.spawnChild = options.spawnChild;
    this.onTurnStarted = options.onTurnStarted;
    this.stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_RING_LIMIT;
    this.ids = options.ids;
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
        brokerTurnId: params.brokerTurnId ?? null,
        interrupted: false,
      };
    }

    return entry.controller.turnInterrupt({
      brokerTurnId: params.brokerTurnId,
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    const entries = [...this.controllers.values()];
    this.controllers.clear();
    this.emitHostStats();
    await Promise.all(
      entries.map(async (entry) => {
        entry.dispose();
        entry.pendingNotifications = [];
        await entry.controller.shutdown();
      }),
    );
    this.resolvePoolClosed();
  }

  private createControllerEntry(brokerSessionKey: string, holdNotifications: boolean): ControllerEntry {
    const controller = new SingleSessionController({
      spawnChild: this.spawnChild,
      ids: this.ids,
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

    this.emitNotification(routed);
    if (notification.method === 'turn/completed' || notification.method === 'turn/failed') {
      this.emitHostStats();
      if (entry.controller.canEvictReachableIdleController()) {
        void this.removeController(brokerSessionKey).catch(() => {});
      }
    }
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
        this.emitNotification(notification);
      }
    });
  }

  private async removeController(brokerSessionKey: string): Promise<void> {
    const entry = this.controllers.get(brokerSessionKey);
    if (!entry) {
      return;
    }

    entry.dispose();
    this.controllers.delete(brokerSessionKey);
    this.emitHostStats();
    await entry.controller.shutdown();
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

export function createBrokerSession(options: CreateBrokerSessionOptions): ClaudeBrokerSession {
  return new BrokerSessionPool(options);
}
