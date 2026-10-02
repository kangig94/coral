import type * as MockedNodeFsModule from 'node:fs';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_BUFFER } from '#src/infra/process-constants.js';
import { SingleSessionController } from '#src/providers/claude/appserver/controller.js';
import type { ControllerNotification } from '#src/providers/claude/appserver/session-contract.js';
import { FakeClaudeChild } from '#tests/helpers/fake-claude-child.js';

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof MockedNodeFsModule>();
  const { InMemoryStorage } = await import('#tools/simulation/core/memory-storage.js');
  const { VirtualTime } = await import('#tools/simulation/core/virtual-time.js');
  const storage = new InMemoryStorage(new VirtualTime());
  return {
    ...original,
    mkdirSync: storage.mkdirSync.bind(storage),
    writeFileSync: storage.writeFileSync.bind(storage),
    appendFileSync: storage.appendFileSync.bind(storage),
    existsSync: storage.existsSync.bind(storage),
    readdirSync: storage.readdirSync.bind(storage),
    statSync: storage.statSync.bind(storage),
    openSync: storage.openSync.bind(storage),
    readSync: storage.readSync.bind(storage),
    closeSync: storage.closeSync.bind(storage),
    fstatSync: (fd: number) => ({ size: Number(storage.fstatSync(fd, { bigint: true }).size) }),
  };
});

let fixtureIndex = 0;

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TEST_MODEL = 'claude-sonnet-test';

const FAST_TIMING = { readySettleMs: 5, promptAckTimeoutMs: 10 } as const;

type TranscriptFixture = {
  transcriptPath: string;
  projectsRoot: string;
  cleanup: () => void;
};

function createTranscriptFixture(conversationRef = TEST_SESSION_ID): TranscriptFixture {
  const home = '/transcripts/fixture-' + fixtureIndex++;
  const projectDir = join(home, '.claude', 'projects', 'workspace');
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${conversationRef}.jsonl`);
  writeFileSync(transcriptPath, '');

  return {
    transcriptPath,
    projectsRoot: join(home, '.claude', 'projects'),
    cleanup: (): void => {},
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

type UsageControllerHarness = {
  controller: SingleSessionController;
  notifications: ControllerNotification[];
  transcriptPath: string;
};

type TurnCompletedNotification = Extract<ControllerNotification, { method: 'turn/completed' }>;

function completedNotification(
  notifications: readonly ControllerNotification[],
): TurnCompletedNotification | undefined {
  return notifications.find(
    (notification): notification is TurnCompletedNotification => notification.method === 'turn/completed',
  );
}

async function startUsageController(): Promise<UsageControllerHarness> {
  const fixture = createTranscriptFixture();
  const child = new FakeClaudeChild();
  const notifications: ControllerNotification[] = [];
  const controller = new SingleSessionController({
    spawnChild: () => child,
    ids: { uuid: () => TEST_SESSION_ID },
    monotonicNow: () => BigInt(Date.now()),
    readySettleMs: 1,
    promptAckTimeoutMs: 10_000,
  });
  controller.subscribeNotifications((notification) => {
    notifications.push(notification);
  });

  await ensureReady(controller, {
    cwd: '/workspace',
    projectsRoot: fixture.projectsRoot,
    systemPromptHash: 'sha256:test',

    bootstrapConfigHash: 'sha256:test-bootstrap',
    permissionMode: 'default',
  });
  await controller.turnStart({ brokerTurnId: 'turn-usage', prompt: 'hello' });

  return { controller, notifications, transcriptPath: fixture.transcriptPath };
}

function assistantUsageTranscriptLine(options: {
  text: string;
  usage: Record<string, unknown>;
  messageId?: string;
  requestId?: string;
  stopReason?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: TEST_SESSION_ID,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    message: {
      role: 'assistant',
      ...(options.messageId === undefined ? {} : { id: options.messageId }),
      model: TEST_MODEL,
      usage: options.usage,
      content: [{ type: 'text', text: options.text }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

async function completeFromTranscriptRows(
  harness: UsageControllerHarness,
  rows: readonly string[],
): Promise<TurnCompletedNotification> {
  appendFileSync(harness.transcriptPath, rows.join('\n') + '\n');
  await vi.advanceTimersByTimeAsync(1_600);
  const completed = completedNotification(harness.notifications);
  expect(completed).toBeDefined();
  return completed as TurnCompletedNotification;
}

describe('SingleSessionController PTY lifecycle', () => {
  it('waits for Claude terminal readiness before accepting the first turn', async () => {
    const child = new FakeClaudeChild(false);
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      monotonicNow: () => BigInt(Date.now()),
      ...FAST_TIMING,
    });

    const ensurePromise = controller.sessionEnsure({
      cwd: '/workspace',
      projectsRoot: '/tmp/coral-test-home/.claude/projects',
      systemPromptHash: 'sha256:test',

      bootstrapConfigHash: 'sha256:test-bootstrap',
      permissionMode: 'default',
    });
    let ensured = false;
    void ensurePromise.then(() => {
      ensured = true;
    });
    await Promise.resolve();

    expect(ensured).toBe(false);

    child.emitData('\x1b[?2004h');
    await vi.advanceTimersByTimeAsync(10);
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
      monotonicNow: () => BigInt(Date.now()),
      ...FAST_TIMING,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    await ensureReady(controller, {
      cwd: '/workspace',
      projectsRoot: '/tmp/coral-test-home/.claude/projects',
      systemPromptHash: 'sha256:test',

      bootstrapConfigHash: 'sha256:test-bootstrap',
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
      monotonicNow: () => BigInt(Date.now()),
      ...FAST_TIMING,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    await ensureReady(controller, {
      cwd: '/workspace',
      projectsRoot: '/tmp/coral-test-home/.claude/projects',
      systemPromptHash: 'sha256:test',

      bootstrapConfigHash: 'sha256:test-bootstrap',
      permissionMode: 'default',
    });
    await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });

    // No transcript exists for this synthetic session, so the prompt is never
    // acknowledged: the controller re-sends on its cadence, then fails fast
    // rather than blocking until the turn timeout.
    const paste = '\x1b[200~hello\x1b[201~\r';
    expect(child.writes.filter((w) => w === paste)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);

    expect(controller.hasActiveTurn()).toBe(false);
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
      monotonicNow: () => BigInt(Date.now()),
      readySettleMs: 5,
      promptAckTimeoutMs: 2_000,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    try {
      await ensureReady(controller, {
        cwd: '/workspace',
        projectsRoot: fixture.projectsRoot,
        systemPromptHash: 'sha256:test',

        bootstrapConfigHash: 'sha256:test-bootstrap',
        permissionMode: 'default',
      });
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });

      const assistantLine = assistantTranscriptLine('split transcript ok');
      const splitAt = Math.floor(assistantLine.length / 2);
      appendFileSync(fixture.transcriptPath, assistantLine.slice(0, splitAt));
      await vi.advanceTimersByTimeAsync(150);
      appendFileSync(fixture.transcriptPath, `${assistantLine.slice(splitAt)}\n${durationTranscriptLine(25)}\n`);

      await vi.advanceTimersByTimeAsync(2_000);

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
      monotonicNow: () => BigInt(Date.now()),
      readySettleMs: 5,
      promptAckTimeoutMs: 5_000,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    try {
      await ensureReady(controller, {
        cwd: '/workspace',
        projectsRoot: fixture.projectsRoot,
        systemPromptHash: 'sha256:test',

        bootstrapConfigHash: 'sha256:test-bootstrap',
        permissionMode: 'default',
      });
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });

      appendFileSync(fixture.transcriptPath, 'x'.repeat(MAX_BUFFER + 1));

      await vi.advanceTimersByTimeAsync(2_000);

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

describe('Claude TUI usage accumulation', () => {
  it('sums three distinct assistant responses', async () => {
    const harness = await startUsageController();
    try {
      const completed = await completeFromTranscriptRows(harness, [
        assistantUsageTranscriptLine({
          text: 'first response',
          messageId: 'msg-1',
          requestId: 'req-1',
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
            costUSD: 0.1,
          },
        }),
        assistantUsageTranscriptLine({
          text: 'second response',
          messageId: 'msg-2',
          requestId: 'req-2',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
            costUSD: 0.2,
          },
        }),
        assistantUsageTranscriptLine({
          text: 'third response',
          messageId: 'msg-3',
          requestId: 'req-3',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 400,
            costUSD: 0.3,
          },
          stopReason: 'end_turn',
        }),
        durationTranscriptLine(12),
      ]);

      expect(completed.params.usage).toEqual({
        input_tokens: 111,
        cache_creation_input_tokens: 222,
        cache_read_input_tokens: 333,
        output_tokens: 444,
      });
      expect(completed.params.costUsd).toBe(0.3);
    } finally {
      await harness.controller.shutdown();
    }
  });

  it('counts duplicate rows with identical message id, request id, and usage once', async () => {
    const harness = await startUsageController();
    try {
      const duplicate = assistantUsageTranscriptLine({
        text: 'duplicate response',
        messageId: 'msg-duplicate',
        requestId: 'req-duplicate',
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 11,
          cache_read_input_tokens: 13,
          output_tokens: 17,
          costUSD: 0.07,
        },
      });
      const completed = await completeFromTranscriptRows(harness, [
        duplicate,
        duplicate,
        assistantUsageTranscriptLine({
          text: 'final response',
          messageId: 'msg-final',
          requestId: 'req-final',
          usage: {
            input_tokens: 19,
            cache_creation_input_tokens: 23,
            cache_read_input_tokens: 29,
            output_tokens: 31,
            costUSD: 0.09,
          },
          stopReason: 'end_turn',
        }),
        durationTranscriptLine(14),
      ]);

      expect(completed.params.usage).toEqual({
        input_tokens: 26,
        cache_creation_input_tokens: 34,
        cache_read_input_tokens: 42,
        output_tokens: 48,
      });
      expect(completed.params.costUsd).toBe(0.09);
    } finally {
      await harness.controller.shutdown();
    }
  });
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function ensureReady(
  controller: SingleSessionController,
  params: Parameters<SingleSessionController['sessionEnsure']>[0],
) {
  const ensure = controller.sessionEnsure(params);
  await vi.advanceTimersByTimeAsync(10);
  return ensure;
}
