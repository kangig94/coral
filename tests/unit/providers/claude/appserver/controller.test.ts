import { describe, expect, it } from 'vitest';

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

const FAST_TIMING = { readySettleMs: 5, promptAckTimeoutMs: 10 } as const;

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('SingleSessionController PTY lifecycle', () => {
  it('waits for Claude terminal readiness before accepting the first turn', async () => {
    const child = new FakeClaudeChild(false);
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      ...FAST_TIMING,
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
    await ensurePromise;

    await controller.turnStart({
      brokerTurnId: 'turn-1',
      prompt: 'hello',
    });

    expect(child.writes[0]).toBe('\x1b[200~hello\x1b[201~\r');

    await controller.shutdown();
  });

  it('clears the active turn and emits failure when an interactive turn is interrupted', async () => {
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      ...FAST_TIMING,
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

  it('re-sends a dropped prompt and fails fast when Claude never registers the turn', async () => {
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      ...FAST_TIMING,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    await controller.sessionEnsure({
      cwd: '/workspace',
      systemPromptHash: 'sha256:test',
      permissionMode: 'default',
    });
    await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });

    // No transcript exists for this synthetic session, so the prompt is never
    // acknowledged: the controller re-sends on its cadence, then fails fast
    // rather than blocking until the turn timeout.
    const paste = '\x1b[200~hello\x1b[201~\r';
    expect(child.writes.filter((w) => w === paste)).toHaveLength(1);

    await waitFor(() => !controller.hasActiveTurn());

    expect(controller.hasActiveTurn()).toBe(false);
    // initial send + MAX_PROMPT_RESENDS (3) = 4 deliveries
    expect(child.writes.filter((w) => w === paste)).toHaveLength(4);
    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/failed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          message: expect.stringContaining('did not register the prompt'),
        }),
      }),
    );

    await controller.shutdown();
  });
});
