import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { MAX_BUFFER } from '#src/infra/process-constants.js';
import { SingleSessionController } from '#src/providers/claude/appserver/controller.js';
import type {
  ChildExit,
  ClaudeBrokerChild,
  ControllerNotification,
} from '#src/providers/claude/appserver/session-contract.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TEST_MODEL = 'claude-sonnet-test';

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
  if (!predicate()) {
    throw new Error(`Timed out after ${timeoutMs}ms`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type TranscriptFixture = {
  transcriptPath: string;
  cleanup: () => void;
};

function createTranscriptFixture(conversationRef = TEST_SESSION_ID): TranscriptFixture {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'coral-claude-home-'));
  const projectDir = join(home, '.claude', 'projects', 'workspace');
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${conversationRef}.jsonl`);
  writeFileSync(transcriptPath, '');
  process.env.HOME = home;

  return {
    transcriptPath,
    cleanup: (): void => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function assistantTranscriptLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: TEST_SESSION_ID,
    message: {
      model: TEST_MODEL,
      usage: { costUSD: 0.01 },
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  });
}

function durationTranscriptLine(durationMs: number): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    session_id: TEST_SESSION_ID,
    durationMs,
  });
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

  it('becomes ready only after output goes quiet, re-arming on each chunk', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeClaudeChild(false);
      const controller = new SingleSessionController({
        spawnChild: () => child,
        ids: { uuid: () => TEST_SESSION_ID },
        readySettleMs: 100,
      });

      const ensure = controller.sessionEnsure({
        cwd: '/workspace',
        systemPromptHash: 'sha256:test',
        permissionMode: 'default',
      });
      let ready = false;
      void ensure.then(() => {
        ready = true;
      });
      await Promise.resolve();
      await Promise.resolve();

      child.emitData('\x1b[?2004h'); // marker arms the quiet timer
      await vi.advanceTimersByTimeAsync(60);
      expect(ready).toBe(false); // still inside the quiet window

      child.emitData('…more TUI render…'); // re-arms the quiet timer
      await vi.advanceTimersByTimeAsync(60);
      expect(ready).toBe(false); // only 60ms since the last chunk

      await vi.advanceTimersByTimeAsync(60); // now quiet for >= 100ms
      await ensure;
      expect(ready).toBe(true);

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

  it('assembles transcript JSONL split across poll reads', async () => {
    const fixture = createTranscriptFixture();
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      readySettleMs: 5,
      promptAckTimeoutMs: 2_000,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    try {
      await controller.sessionEnsure({
        cwd: '/workspace',
        systemPromptHash: 'sha256:test',
        permissionMode: 'default',
      });
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });

      const assistantLine = assistantTranscriptLine('split transcript ok');
      const splitAt = Math.floor(assistantLine.length / 2);
      appendFileSync(fixture.transcriptPath, assistantLine.slice(0, splitAt));
      await sleep(150);
      appendFileSync(fixture.transcriptPath, `${assistantLine.slice(splitAt)}\n${durationTranscriptLine(25)}\n`);

      await waitFor(() => notifications.some((notification) => notification.method === 'turn/completed'));

      expect(notifications).toContainEqual(
        expect.objectContaining({
          method: 'turn/completed',
          params: expect.objectContaining({
            brokerTurnId: 'turn-1',
            result: 'split transcript ok',
            model: TEST_MODEL,
            durationMs: 25,
            isError: false,
          }),
        }),
      );
    } finally {
      await controller.shutdown();
      fixture.cleanup();
    }
  });

  it('fails a turn when an unterminated transcript line exceeds the cap', async () => {
    const fixture = createTranscriptFixture();
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      readySettleMs: 5,
      promptAckTimeoutMs: 5_000,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    try {
      await controller.sessionEnsure({
        cwd: '/workspace',
        systemPromptHash: 'sha256:test',
        permissionMode: 'default',
      });
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });

      appendFileSync(fixture.transcriptPath, 'x'.repeat(MAX_BUFFER + 1));

      await waitFor(() =>
        notifications.some(
          (notification) =>
            notification.method === 'turn/failed' &&
            notification.params.message.includes('transcript JSONL line exceeded'),
        ),
      );

      expect(notifications).toContainEqual(
        expect.objectContaining({
          method: 'turn/failed',
          params: expect.objectContaining({
            brokerTurnId: 'turn-1',
            message: expect.stringContaining('transcript JSONL line exceeded'),
          }),
        }),
      );
      expect(controller.hasActiveTurn()).toBe(false);
    } finally {
      await controller.shutdown();
      fixture.cleanup();
    }
  });
});
