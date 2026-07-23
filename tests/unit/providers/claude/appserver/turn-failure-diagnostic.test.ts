import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SingleSessionController, type TurnPhase } from '#src/providers/claude/appserver/controller.js';
import {
  turnFailureDiagnosticPhaseSchema,
  turnFailureDiagnosticReasonSchema,
} from '#src/providers/claude/appserver/protocol.js';
import {
  sessionProviderFailureDiagnosticPhaseSchema,
  sessionProviderFailureDiagnosticReasonSchema,
} from '#src/sessions/fault.js';
import type { ControllerNotification } from '#src/providers/claude/appserver/session-contract.js';
import { FakeClaudeChild } from '#tests/helpers/fake-claude-child.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000501';

type TranscriptFixture = {
  readonly transcriptPath: string;
  readonly projectsRoot: string;
  cleanup(): void;
};

type ActiveTurnForTest = {
  lastPromptSentAt: number;
  phase: TurnPhase;
  phaseEnteredAt: number;
  promptSendAttempts: number;
};

type ControllerInternals = {
  activeTurn: ActiveTurnForTest | null;
  failActiveTurn(turn: ActiveTurnForTest, message: string): void;
};

function createTranscriptFixture(conversationRef = TEST_SESSION_ID): TranscriptFixture {
  const previousHome = process.env.HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const home = mkdtempSync(join(tmpdir(), 'coral-claude-diagnostic-home-'));
  const projectDir = join(home, '.claude', 'projects', 'workspace');
  mkdirSync(projectDir, { recursive: true });
  const transcriptPath = join(projectDir, `${conversationRef}.jsonl`);
  writeFileSync(transcriptPath, '');
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;

  return {
    transcriptPath,
    projectsRoot: join(home, '.claude', 'projects'),
    cleanup() {
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

function failedNotification(
  notifications: readonly ControllerNotification[],
): Extract<ControllerNotification, { method: 'turn/failed' }> | undefined {
  return notifications.find(
    (notification): notification is Extract<ControllerNotification, { method: 'turn/failed' }> =>
      notification.method === 'turn/failed',
  );
}

describe('Claude turn failure diagnostics', () => {
  it('keeps protocol and session diagnostic literal sets identical', () => {
    expect(sessionProviderFailureDiagnosticReasonSchema.options).toEqual(turnFailureDiagnosticReasonSchema.options);
    expect(sessionProviderFailureDiagnosticPhaseSchema.options).toEqual(turnFailureDiagnosticPhaseSchema.options);
  });

  it('replaces the retired stderr tail with a structured diagnostic payload', async () => {
    const fixture = createTranscriptFixture();
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      readySettleMs: 1,
      promptAckTimeoutMs: 10,
      stderrLimit: 512,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    try {
      await controller.sessionEnsure({
        cwd: '/workspace',
        projectsRoot: fixture.projectsRoot,
        systemPromptHash: 'sha256:test',

        bootstrapConfigHash: 'sha256:test-bootstrap',
        permissionMode: 'default',
      });
      child.emitData('API Error: upstream overloaded\n');
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      appendFileSync(fixture.transcriptPath, 'not-json transcript tail sentinel\n');

      const internals = controller as unknown as ControllerInternals;
      expect(internals.activeTurn).not.toBeNull();
      const turn = internals.activeTurn as ActiveTurnForTest;
      turn.lastPromptSentAt = Date.now() - 42;
      turn.promptSendAttempts = 4;
      internals.failActiveTurn(turn, 'Claude did not register the prompt after resend attempts.');

      const failed = failedNotification(notifications);
      expect(failed?.params).not.toHaveProperty('stderr');
      expect(failed?.params.diagnostic.childOutputTail).toContain('API Error: upstream overloaded');
      expect(failed?.params.diagnostic.transcriptTail).toContain('transcript tail sentinel');
      expect(failed?.params.diagnostic).toMatchObject({
        reason: 'api-error',
        phase: 'sent',
        attempts: 3,
        sessionId: TEST_SESSION_ID,
        conversationRef: TEST_SESSION_ID,
      });
      expect(failed?.params.diagnostic.idleMs).toBeGreaterThanOrEqual(42);
    } finally {
      await controller.shutdown();
      fixture.cleanup();
    }
  });

  it('emits child-exit as the broker-layer failure reason when the child exits mid-turn', async () => {
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      readySettleMs: 1,
      promptAckTimeoutMs: 10_000,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    try {
      await controller.sessionEnsure({
        cwd: '/workspace',
        projectsRoot: '/tmp/coral-test-home/.claude/projects',
        systemPromptHash: 'sha256:test',

        bootstrapConfigHash: 'sha256:test-bootstrap',
        permissionMode: 'default',
      });
      await controller.turnStart({ brokerTurnId: 'turn-child-exit', prompt: 'hello' });

      child.emitExit({ code: 1, signal: null });

      expect(failedNotification(notifications)?.params.diagnostic).toMatchObject({
        reason: 'child-exit',
        phase: 'sent',
      });
    } finally {
      await controller.shutdown();
    }
  });

  it('emits finalization-failure as the broker-layer failure reason for ending-phase failures', async () => {
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      readySettleMs: 1,
      promptAckTimeoutMs: 10_000,
    });
    controller.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    try {
      await controller.sessionEnsure({
        cwd: '/workspace',
        projectsRoot: '/tmp/coral-test-home/.claude/projects',
        systemPromptHash: 'sha256:test',

        bootstrapConfigHash: 'sha256:test-bootstrap',
        permissionMode: 'default',
      });
      await controller.turnStart({ brokerTurnId: 'turn-finalization', prompt: 'hello' });

      const internals = controller as unknown as ControllerInternals;
      expect(internals.activeTurn).not.toBeNull();
      const turn = internals.activeTurn as ActiveTurnForTest;
      turn.phase = 'ending';
      turn.phaseEnteredAt = Date.now() - 1_500;
      internals.failActiveTurn(turn, 'Claude finalization failed while completing the turn.');

      expect(failedNotification(notifications)?.params.diagnostic).toMatchObject({
        reason: 'finalization-failure',
        phase: 'ending',
      });
    } finally {
      await controller.shutdown();
    }
  });
});
