import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as waitImmediate } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrokerSessionPool } from '#src/providers/claude/appserver/broker-pool.js';
import { SingleSessionController, type TurnPhase } from '#src/providers/claude/appserver/controller.js';
import type { ClaudeBrokerNotification } from '#src/providers/claude/appserver/protocol.js';
import type {
  ControllerNotification,
  SpawnClaudeChildOptions,
} from '#src/providers/claude/appserver/session-contract.js';
import { DEFAULT_TURN_RECOVERY_BUDGET } from '#src/providers/claude/appserver/turn-recovery-budget.js';
import { DEFAULT_STALE_TIMEOUT_MS } from '#src/workflow/execution-constants.js';
import { FakeClaudeChild } from '#tests/helpers/fake-claude-child.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000101';
const TEST_MODEL = 'claude-sonnet-test';
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~\r';

type ActiveTurnForTest = {
  brokerTurnId: string;
  phase: TurnPhase;
  phaseEnteredAt: number;
  lastSemanticProgressAt: number;
  promptTranscriptOffset: number;
  lastPromptSentAt: number;
  replacementAttempts: number;
  continuationSentAt: number | null;
  continuationPhase: 'registered' | 'responding' | null;
};

type ControllerInternals = {
  activeTurn: ActiveTurnForTest | null;
  processTranscriptLine(turn: ActiveTurnForTest, line: string, lineStartOffset: number): void;
  readTranscriptAppend(turn: ActiveTurnForTest): void;
  recoverStalledTurn(turn: ActiveTurnForTest, now: number): Promise<boolean>;
};

type ControllerHarness = {
  controller: SingleSessionController;
  internals: ControllerInternals;
  children: FakeClaudeChild[];
  spawnOptions: SpawnClaudeChildOptions[];
  spawnTimes: number[];
  notifications: ControllerNotification[];
  startedTurns: string[];
};

const controllers: SingleSessionController[] = [];
const pools: BrokerSessionPool[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const controller of controllers.splice(0)) {
    await controller.turnInterrupt({ brokerTurnId: 'turn-1' });
    await controller.shutdown();
  }
  for (const pool of pools.splice(0)) {
    await pool.shutdown();
  }
});

function createControllerHarness(): ControllerHarness {
  const children: FakeClaudeChild[] = [];
  const spawnOptions: SpawnClaudeChildOptions[] = [];
  const spawnTimes: number[] = [];
  const notifications: ControllerNotification[] = [];
  const startedTurns: string[] = [];
  const controller = new SingleSessionController({
    spawnChild: (options) => {
      spawnOptions.push(options);
      spawnTimes.push(Date.now());
      const child = new FakeClaudeChild();
      children.push(child);
      return child;
    },
    ids: { uuid: () => TEST_SESSION_ID },
    onTurnStarted: ({ brokerTurnId }) => {
      startedTurns.push(brokerTurnId);
    },
    readySettleMs: 1,
    promptAckTimeoutMs: DEFAULT_TURN_RECOVERY_BUDGET.registration.promptAckMs,
  });
  controller.subscribeNotifications((notification) => {
    notifications.push(notification);
  });
  controllers.push(controller);

  return {
    controller,
    internals: controller as unknown as ControllerInternals,
    children,
    spawnOptions,
    spawnTimes,
    notifications,
    startedTurns,
  };
}

async function ensureController(harness: ControllerHarness): Promise<void> {
  await harness.controller.sessionEnsure({
    cwd: '/workspace',
    systemPromptHash: 'sha256:test',
    permissionMode: 'default',
  });
}

async function startController(prompt = 'hello'): Promise<ControllerHarness> {
  const harness = createControllerHarness();
  await ensureController(harness);
  await harness.controller.turnStart({ brokerTurnId: 'turn-1', prompt });
  return harness;
}

function activeTurn(internals: ControllerInternals): ActiveTurnForTest {
  expect(internals.activeTurn).not.toBeNull();
  return internals.activeTurn as ActiveTurnForTest;
}

function processLine(
  internals: ControllerInternals,
  line: string,
  lineStartOffset = activeTurn(internals).promptTranscriptOffset,
): void {
  internals.processTranscriptLine(activeTurn(internals), line, lineStartOffset);
}

function userPromptLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: TEST_SESSION_ID,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

type TranscriptFixture = {
  transcriptPath: string;
  cleanup: () => void;
};

function createTranscriptFixture(conversationRef = TEST_SESSION_ID): TranscriptFixture {
  const previousHome = process.env.HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const home = mkdtempSync(join(tmpdir(), 'coral-claude-home-'));
  const projectDir = join(home, '.claude', 'projects', 'workspace');
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${conversationRef}.jsonl`);
  writeFileSync(transcriptPath, '');
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;

  return {
    transcriptPath,
    cleanup: (): void => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function assistantLine(text: string, stopReason?: string): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: TEST_SESSION_ID,
    message: {
      role: 'assistant',
      model: TEST_MODEL,
      content: [{ type: 'text', text }],
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
  });
}

function durationLine(durationMs: number): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    session_id: TEST_SESSION_ID,
    durationMs,
  });
}

function unwrapPaste(write: string): string {
  expect(write.startsWith(BRACKETED_PASTE_START)).toBe(true);
  expect(write.endsWith(BRACKETED_PASTE_END)).toBe(true);
  return write.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
}

type ControllerTurnNotification = Extract<
  ControllerNotification,
  { method: 'turn/progress' | 'turn/completed' | 'turn/failed' }
>;

function isControllerTurnNotification(notification: ControllerNotification): notification is ControllerTurnNotification {
  return notification.method.startsWith('turn/');
}

function isControllerTurnCompleted(
  notification: ControllerNotification,
): notification is Extract<ControllerNotification, { method: 'turn/completed' }> {
  return notification.method === 'turn/completed';
}

function turnNotifications(notifications: ControllerNotification[]): ControllerTurnNotification[] {
  return notifications.filter(isControllerTurnNotification);
}

describe('Claude phase-specific turn-stall recovery', () => {
  it('resends the original prompt only while the turn is still sent', async () => {
    const harness = await startController('original sent prompt');
    const turn = activeTurn(harness.internals);

    const terminated = await harness.internals.recoverStalledTurn(
      turn,
      turn.lastPromptSentAt + DEFAULT_TURN_RECOVERY_BUDGET.registration.promptAckMs,
    );

    expect(terminated).toBe(false);
    expect(harness.children).toHaveLength(1);
    expect(harness.children[0]?.writes.map(unwrapPaste)).toEqual([
      'original sent prompt',
      'original sent prompt',
    ]);
    expect(harness.startedTurns).toEqual(['turn-1']);
  });

  it('recovers a registered stall by respawning with resume and continuing the unanswered message', async () => {
    const harness = await startController('registered prompt must not duplicate');
    processLine(harness.internals, userPromptLine('registered prompt must not duplicate'));
    const turn = activeTurn(harness.internals);
    expect(turn.phase).toBe('registered');

    const terminated = await harness.internals.recoverStalledTurn(
      turn,
      turn.phaseEnteredAt + DEFAULT_TURN_RECOVERY_BUDGET['assistant-start'].assistantStartIdleMs,
    );

    expect(terminated).toBe(false);
    expect(harness.spawnOptions).toHaveLength(2);
    expect(harness.spawnOptions[1]).toMatchObject({
      conversationRef: TEST_SESSION_ID,
      resume: true,
    });
    expect(harness.children[0]?.killSignals).toEqual(['SIGTERM']);
    expect(harness.children[0]?.writes.map(unwrapPaste)).toEqual([
      'registered prompt must not duplicate',
    ]);
    const continuation = unwrapPaste(harness.children[1]?.writes[0] ?? '');
    expect(continuation).toContain('unanswered user message');
    expect(continuation).not.toContain('registered prompt must not duplicate');
    expect(harness.startedTurns).toEqual(['turn-1']);

    processLine(harness.internals, assistantLine('recovered answer', 'end_turn'));
    processLine(harness.internals, durationLine(25));
    await harness.internals.recoverStalledTurn(activeTurn(harness.internals), Date.now());

    const completed = harness.notifications.find(isControllerTurnCompleted);
    expect(completed?.params.brokerTurnId).toBe('turn-1');
    expect(completed?.params.result).toBe('recovered answer');
    expect(turnNotifications(harness.notifications).every((notification) => {
      return notification.params.brokerTurnId === 'turn-1';
    })).toBe(true);
  });

  it('fires registered idle recovery within the assistant-start budget', async () => {
    const prompt = 'registered prompt then silence';
    const assistantStartBudgetMs =
      DEFAULT_TURN_RECOVERY_BUDGET['assistant-start'].assistantStartIdleMs;
    const fixture = createTranscriptFixture();
    try {
      const harness = createControllerHarness();
      await ensureController(harness);

      await harness.controller.turnStart({ brokerTurnId: 'turn-1', prompt });
      vi.useFakeTimers();
      vi.setSystemTime(0);
      appendFileSync(fixture.transcriptPath, `${userPromptLine(prompt)}\n`);

      harness.internals.readTranscriptAppend(activeTurn(harness.internals));
      const registeredTurn = activeTurn(harness.internals);
      expect(registeredTurn.phase).toBe('registered');
      const registeredAt = registeredTurn.phaseEnteredAt;

      vi.setSystemTime(registeredAt + assistantStartBudgetMs - 1);
      await expect(harness.internals.recoverStalledTurn(registeredTurn, Date.now())).resolves.toBe(false);
      expect(harness.spawnOptions).toHaveLength(1);
      expect(activeTurn(harness.internals).phase).toBe('registered');

      vi.setSystemTime(registeredAt + assistantStartBudgetMs);
      const recovery = harness.internals.recoverStalledTurn(registeredTurn, Date.now());
      await vi.advanceTimersByTimeAsync(1);
      await expect(recovery).resolves.toBe(false);
      expect(harness.spawnOptions).toHaveLength(2);
      const recoveryFiredAt = harness.spawnTimes[1];
      expect(recoveryFiredAt).toBeDefined();
      expect(recoveryFiredAt - registeredAt).toBeLessThanOrEqual(assistantStartBudgetMs);
      expect(recoveryFiredAt - registeredAt).toBeLessThan(DEFAULT_STALE_TIMEOUT_MS);
      expect(recoveryFiredAt).toBeLessThan(DEFAULT_STALE_TIMEOUT_MS);

      const recoveredTurn = activeTurn(harness.internals);
      expect(recoveredTurn.replacementAttempts).toBe(1);
      expect(recoveredTurn.continuationPhase).toBe('registered');
      expect(
        harness.notifications.some((notification) => notification.method === 'turn/failed'),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('recovers a responding stall with a partial-response continuation and never re-pastes the original prompt', async () => {
    const originalPrompt = 'ORIGINAL_PROMPT_SHOULD_NOT_REAPPEAR';
    const harness = await startController(originalPrompt);
    processLine(harness.internals, userPromptLine(originalPrompt));
    processLine(harness.internals, assistantLine('partial answer'));
    const turn = activeTurn(harness.internals);
    expect(turn.phase).toBe('responding');

    const terminated = await harness.internals.recoverStalledTurn(
      turn,
      turn.lastSemanticProgressAt + DEFAULT_TURN_RECOVERY_BUDGET['assistant-progress'].assistantProgressIdleMs,
    );

    expect(terminated).toBe(false);
    expect(harness.spawnOptions).toHaveLength(2);
    expect(harness.spawnOptions[1]).toMatchObject({
      conversationRef: TEST_SESSION_ID,
      resume: true,
    });
    expect(harness.children[0]?.writes.map(unwrapPaste)).toEqual([originalPrompt]);
    const continuation = unwrapPaste(harness.children[1]?.writes[0] ?? '');
    expect(continuation).toContain('partial assistant response');
    expect(continuation).not.toContain(originalPrompt);
    expect(harness.startedTurns).toEqual(['turn-1']);
    expect(turnNotifications(harness.notifications).every((notification) => {
      return notification.params.brokerTurnId === 'turn-1';
    })).toBe(true);
  });

  it('completes an ending turn from parsed transcript fields after the finalization grace', async () => {
    const harness = await startController('ending prompt');
    processLine(harness.internals, userPromptLine('ending prompt'));
    processLine(harness.internals, assistantLine('parsed final answer', 'end_turn'));
    processLine(harness.internals, durationLine(123));
    const turn = activeTurn(harness.internals);
    expect(turn.phase).toBe('ending');

    const terminated = await harness.internals.recoverStalledTurn(
      turn,
      turn.phaseEnteredAt + DEFAULT_TURN_RECOVERY_BUDGET['finalization-grace'].finalizationGraceMs,
    );

    expect(terminated).toBe(true);
    expect(harness.controller.hasActiveTurn()).toBe(false);
    expect(harness.notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          result: 'parsed final answer',
          durationMs: 123,
        }),
      }),
    );
  });

  it('terminates with a structured failure when respawn attempts are exhausted', async () => {
    const harness = await startController('registered exhaustion prompt');
    processLine(harness.internals, userPromptLine('registered exhaustion prompt'));
    const turn = activeTurn(harness.internals);
    turn.replacementAttempts = DEFAULT_TURN_RECOVERY_BUDGET.replacement.respawnAttempts;

    const terminated = await harness.internals.recoverStalledTurn(
      turn,
      turn.phaseEnteredAt + DEFAULT_TURN_RECOVERY_BUDGET['assistant-start'].assistantStartIdleMs,
    );

    expect(terminated).toBe(true);
    expect(harness.controller.hasActiveTurn()).toBe(false);
    expect(harness.notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/failed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          diagnostic: expect.objectContaining({
            reason: 'silent-hang',
            phase: 'registered',
            attempts: DEFAULT_TURN_RECOVERY_BUDGET.replacement.respawnAttempts,
          }),
        }),
      }),
    );
  });

  it('does not breach the hard cap while assistant progress keeps resetting the idle clock', async () => {
    const harness = await startController('long streaming prompt');
    vi.useFakeTimers();
    vi.setSystemTime(0);

    processLine(harness.internals, userPromptLine('long streaming prompt'));
    const progressSpacingMs = DEFAULT_TURN_RECOVERY_BUDGET['assistant-progress'].assistantProgressIdleMs - 1;
    const hardCapMs = DEFAULT_TURN_RECOVERY_BUDGET['hard-cap'].hardCapMs;

    for (let elapsed = progressSpacingMs; elapsed <= hardCapMs + progressSpacingMs; elapsed += progressSpacingMs) {
      vi.setSystemTime(elapsed);
      processLine(harness.internals, assistantLine(`stream chunk ${elapsed}`));
    }

    const turn = activeTurn(harness.internals);
    expect(turn.phase).toBe('responding');
    expect(Date.now()).toBeGreaterThan(hardCapMs);
    expect(Date.now() - turn.lastSemanticProgressAt).toBe(0);

    const terminated = await harness.internals.recoverStalledTurn(
      turn,
      Date.now() + DEFAULT_TURN_RECOVERY_BUDGET['assistant-progress'].assistantProgressIdleMs - 1,
    );

    expect(terminated).toBe(false);
    expect(harness.spawnOptions).toHaveLength(1);
    expect(harness.notifications.some((notification) => notification.method === 'turn/failed')).toBe(false);
  });

  it('suppresses a late expected old-child exit after replacement attaches without pool eviction', async () => {
    const children: FakeClaudeChild[] = [];
    const notifications: ClaudeBrokerNotification[] = [];
    const ids = ['broker-1', TEST_SESSION_ID];
    const pool = new BrokerSessionPool({
      spawnChild: () => {
        const child = new FakeClaudeChild();
        children.push(child);
        return child;
      },
      ids: {
        uuid: () => ids.shift() ?? TEST_SESSION_ID,
      },
      onTurnStarted: () => {},
      stderrLimit: 1_024,
    });
    pool.subscribeNotifications((notification) => {
      notifications.push(notification);
    });
    pools.push(pool);

    const ensured = await pool.sessionEnsure({
      cwd: '/workspace',
      systemPromptHash: 'sha256:test',
      permissionMode: 'default',
    });
    await pool.turnStart({
      brokerSessionKey: ensured.brokerSessionKey,
      brokerTurnId: 'turn-1',
      prompt: 'pool prompt',
    });

    const entry = (
      pool as unknown as {
        controllers: Map<string, { controller: SingleSessionController }>;
      }
    ).controllers.get(ensured.brokerSessionKey);
    expect(entry).toBeDefined();
    const internals = entry?.controller as unknown as ControllerInternals;
    processLine(internals, userPromptLine('pool prompt'));
    const turn = activeTurn(internals);
    children[0].exitOnKill = false;

    const terminated = await internals.recoverStalledTurn(
      turn,
      turn.phaseEnteredAt + DEFAULT_TURN_RECOVERY_BUDGET['assistant-start'].assistantStartIdleMs,
    );

    expect(terminated).toBe(false);
    expect(children).toHaveLength(2);
    expect(children[1]?.disposed).toBe(false);
    children[0].emitExit({ code: null, signal: 'SIGTERM' });
    await waitImmediate();

    expect(notifications.some((notification) => notification.method === 'turn/failed')).toBe(false);
    expect(children[1]?.disposed).toBe(false);
    await expect(pool.sessionProbe({ brokerSessionKey: ensured.brokerSessionKey })).resolves.toMatchObject({
      status: 'available',
      activeTurnId: 'turn-1',
    });
  });
});
