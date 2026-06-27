import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  advanceTurnPhase,
  SingleSessionController,
  type TurnPhase,
} from '#src/providers/claude/appserver/controller.js';
import { FakeClaudeChild } from '#tests/helpers/fake-claude-child.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TEST_MODEL = 'claude-sonnet-test';

type ActiveTurnForTest = {
  phase: TurnPhase;
  promptTranscriptOffset: number;
};

type ControllerInternals = {
  activeTurn: ActiveTurnForTest | null;
  processTranscriptLine(turn: ActiveTurnForTest, line: string, lineStartOffset: number): void;
  readTranscriptAppend(turn: ActiveTurnForTest): void;
  resolveTranscriptPath(): string | null;
};

type StartedController = {
  controller: SingleSessionController;
  internals: ControllerInternals;
};

const controllers: SingleSessionController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.turnInterrupt({ brokerTurnId: 'turn-1' });
    await controller.shutdown();
  }
});

async function startController(prompt = 'hello'): Promise<StartedController> {
  const controller = new SingleSessionController({
    spawnChild: () => new FakeClaudeChild(),
    ids: { uuid: () => TEST_SESSION_ID },
    readySettleMs: 1,
    promptAckTimeoutMs: 60_000,
  });
  controllers.push(controller);

  await controller.sessionEnsure({
    cwd: '/workspace',
    systemPromptHash: 'sha256:test',
    permissionMode: 'default',
  });
  await controller.turnStart({ brokerTurnId: 'turn-1', prompt });

  return {
    controller,
    internals: controller as unknown as ControllerInternals,
  };
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

function userPromptLine(
  text: string,
  overrides: {
    sessionId?: string;
    role?: string;
    content?: unknown;
  } = {},
): string {
  return JSON.stringify({
    type: 'user',
    session_id: overrides.sessionId ?? TEST_SESSION_ID,
    message: {
      role: overrides.role ?? 'user',
      content: overrides.content ?? [{ type: 'text', text }],
    },
  });
}

function userToolResultLine(): string {
  return userPromptLine('hello', {
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }],
  });
}

function queueOperationLine(
  content: string,
  overrides: {
    sessionId?: string;
    operation?: string;
    content?: unknown;
  } = {},
): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: overrides.operation ?? 'enqueue',
    sessionId: overrides.sessionId ?? TEST_SESSION_ID,
    content: overrides.content ?? content,
  });
}

function assistantLine(options: { sessionId?: string; stopReason?: string } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: options.sessionId ?? TEST_SESSION_ID,
    message: {
      role: 'assistant',
      model: TEST_MODEL,
      content: [{ type: 'text', text: 'response' }],
      ...(options.stopReason === undefined ? {} : { stop_reason: options.stopReason }),
    },
  });
}

function systemLine(options: { sessionId?: string } = {}): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    session_id: options.sessionId ?? TEST_SESSION_ID,
    durationMs: 25,
  });
}

type TranscriptFixture = {
  transcriptPath: string;
  pathFor: (conversationRef: string, projectName?: string) => string;
  cleanup: () => void;
};

function createTranscriptFixture(
  conversationRef = TEST_SESSION_ID,
  extraConversationRefs: string[] = [],
): TranscriptFixture {
  const previousHome = process.env.HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const home = mkdtempSync(join(tmpdir(), 'coral-claude-home-'));
  const projectDir = join(home, '.claude', 'projects', 'workspace');
  mkdirSync(projectDir, { recursive: true });
  const pathFor = (ref: string, projectName = 'workspace'): string =>
    join(home, '.claude', 'projects', projectName, `${ref}.jsonl`);
  const transcriptPath = pathFor(conversationRef);
  for (const ref of [conversationRef, ...extraConversationRefs]) {
    writeFileSync(pathFor(ref), '');
  }
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;

  return {
    transcriptPath,
    pathFor,
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

describe('Claude turn phase state machine', () => {
  it('advances sent to registered for the canonical current-turn prompt row', async () => {
    const { internals } = await startController('hello\nworld');

    expect(activeTurn(internals).phase).toBe('sent');
    processLine(internals, userPromptLine('hello\r\nworld'));

    expect(activeTurn(internals).phase).toBe('registered');
  });

  it('advances sent to registered for a Claude queue-operation enqueue row', async () => {
    const { internals } = await startController('hello\nworld');

    expect(activeTurn(internals).phase).toBe('sent');
    processLine(internals, queueOperationLine('hello\r\nworld'));

    expect(activeTurn(internals).phase).toBe('registered');
  });

  it('advances registered to responding on an assistant row', async () => {
    const { internals } = await startController();

    processLine(internals, userPromptLine('hello'));
    processLine(internals, assistantLine());

    expect(activeTurn(internals).phase).toBe('responding');
  });

  it('advances responding to ending on an end-turn assistant row', async () => {
    const { internals } = await startController();

    processLine(internals, userPromptLine('hello'));
    processLine(internals, assistantLine({ stopReason: 'end_turn' }));

    expect(activeTurn(internals).phase).toBe('ending');
  });

  it('keeps a turn in ending when a late assistant row arrives after end_turn', async () => {
    const { controller, internals } = await startController();

    processLine(internals, userPromptLine('hello'));
    processLine(internals, assistantLine({ stopReason: 'end_turn' }));
    expect(activeTurn(internals).phase).toBe('ending');

    processLine(internals, assistantLine());

    expect(controller.hasActiveTurn()).toBe(true);
    expect(activeTurn(internals).phase).toBe('ending');
  });

  it('does not register raw transcript bytes or system rows', async () => {
    const fixture = createTranscriptFixture();
    try {
      const { internals } = await startController();
      const turn = activeTurn(internals);

      appendFileSync(fixture.transcriptPath, 'raw transcript bytes\n');
      internals.readTranscriptAppend(turn);
      expect(activeTurn(internals).phase).toBe('sent');

      processLine(internals, systemLine());
      expect(activeTurn(internals).phase).toBe('sent');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not keep reading a cached transcript after the session id changes', async () => {
    const nextSessionId = '00000000-0000-4000-8000-000000000002';
    const fixture = createTranscriptFixture(TEST_SESSION_ID, [nextSessionId]);
    try {
      const { internals } = await startController();
      const turn = activeTurn(internals);

      expect(internals.resolveTranscriptPath()).toBe(fixture.transcriptPath);
      processLine(internals, systemLine({ sessionId: nextSessionId }));
      appendFileSync(fixture.pathFor(nextSessionId), `${assistantLine({ sessionId: nextSessionId })}\n`);
      internals.readTranscriptAppend(turn);

      expect(activeTurn(internals).phase).toBe('responding');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not arbitrarily select a transcript when the conversation ref is ambiguous across projects', async () => {
    const fixture = createTranscriptFixture();
    const duplicatePath = fixture.pathFor(TEST_SESSION_ID, 'other-workspace');
    mkdirSync(join(duplicatePath, '..'), { recursive: true });
    writeFileSync(duplicatePath, '');
    try {
      const { internals } = await startController();

      expect(internals.resolveTranscriptPath()).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('does not register mismatched user rows', async () => {
    const { internals } = await startController();
    const turn = activeTurn(internals);

    processLine(internals, userPromptLine('hello'), turn.promptTranscriptOffset - 1);
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, userPromptLine('different prompt'));
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, userPromptLine('hello', { sessionId: 'other-session' }));
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, userToolResultLine());
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, queueOperationLine('hello'), turn.promptTranscriptOffset - 1);
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, queueOperationLine('different prompt'));
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, queueOperationLine('hello', { sessionId: 'other-session' }));
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, queueOperationLine('hello', { operation: 'dequeue' }));
    expect(activeTurn(internals).phase).toBe('sent');

    processLine(internals, queueOperationLine('hello', { content: { text: 'hello' } }));
    expect(activeTurn(internals).phase).toBe('sent');
  });

  it('does not let user rows after responding regress the phase', async () => {
    const { internals } = await startController();

    processLine(internals, userPromptLine('hello'));
    processLine(internals, assistantLine());
    expect(activeTurn(internals).phase).toBe('responding');

    processLine(internals, userPromptLine('hello'));
    expect(activeTurn(internals).phase).toBe('responding');

    processLine(internals, userToolResultLine());
    expect(activeTurn(internals).phase).toBe('responding');
  });

  it('rejects illegal transitions', () => {
    expect(advanceTurnPhase('sent', 'registered')).toBe('registered');
    expect(advanceTurnPhase('responding', 'responding')).toBe('responding');
    expect(() => advanceTurnPhase('sent', 'ending')).toThrow('sent -> ending');
    expect(() => advanceTurnPhase('responding', 'registered')).toThrow('responding -> registered');
    expect(() => advanceTurnPhase('terminal', 'sent')).toThrow('terminal -> sent');
  });
});
