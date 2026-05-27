import { describe, expect, it, vi } from 'vitest';

import { SingleSessionController } from '#src/providers/claude/appserver/controller.js';
import type {
  ChildExit,
  ClaudeBrokerChild,
  ControllerNotification,
} from '#src/providers/claude/appserver/session-contract.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';

class FakeClaudeChild implements ClaudeBrokerChild {
  readonly writes: string[] = [];
  private readonly dataHandlers = new Set<(chunk: string) => void>();
  private readonly exitHandlers = new Set<(event: ChildExit) => void>();
  private exited = false;

  constructor(private readonly autoReady = true) {}

  write(data: string): void {
    this.writes.push(data);
    if (data === '/exit\r') {
      this.emitExit({ code: 0, signal: null });
    }
  }

  kill(signal?: NodeJS.Signals): void {
    this.emitExit({ code: null, signal: signal ?? null });
  }

  onData(handler: (chunk: string) => void): () => void {
    this.dataHandlers.add(handler);
    if (this.autoReady) {
      queueMicrotask(() => {
        if (this.dataHandlers.has(handler)) {
          handler('\x1b[?2004h');
        }
      });
    }
    return () => {
      this.dataHandlers.delete(handler);
    };
  }

  onExit(handler: (event: ChildExit) => void): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  private emitExit(event: ChildExit): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const handler of this.exitHandlers) {
      handler(event);
    }
  }

  emitData(chunk: string): void {
    for (const handler of this.dataHandlers) {
      handler(chunk);
    }
  }
}

describe('SingleSessionController PTY lifecycle', () => {
  it('waits for Claude terminal readiness before accepting the first turn', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeClaudeChild(false);
      const controller = new SingleSessionController({
        spawnChild: () => child,
        ids: { uuid: () => TEST_SESSION_ID },
      });

      const ensurePromise = controller.sessionEnsure({
        cwd: '/workspace',
        systemPromptHash: 'sha256:test',
        permissionMode: 'default',
      });
      let ensured = false;
      void ensurePromise.then(() => {
        ensured = true;
      });
      await Promise.resolve();

      expect(ensured).toBe(false);

      child.emitData('\x1b[?2004h');
      await vi.advanceTimersByTimeAsync(100);
      await ensurePromise;

      await controller.turnStart({
        brokerTurnId: 'turn-1',
        prompt: 'hello',
      });

      expect(child.writes[0]).toBe('\x1b[200~hello\x1b[201~\r');

      await controller.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the active turn and emits failure when an interactive turn is interrupted', async () => {
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    await controller.sessionEnsure({
      cwd: '/workspace',
      systemPromptHash: 'sha256:test',
      permissionMode: 'default',
    });
    await controller.turnStart({
      brokerTurnId: 'turn-1',
      prompt: 'hello',
    });

    await expect(controller.turnInterrupt({ brokerTurnId: 'turn-1' })).resolves.toEqual({
      brokerTurnId: 'turn-1',
      interrupted: true,
    });

    expect(child.writes).toContain('\x03');
    expect(controller.hasActiveTurn()).toBe(false);
    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/failed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          message: 'Claude turn interrupted.',
          sessionId: TEST_SESSION_ID,
          conversationRef: TEST_SESSION_ID,
        }),
      }),
    );

    await controller.shutdown();
  });
});
