import { describe, expect, it } from 'vitest';

import { SingleSessionController } from '#src/providers/claude/appserver/controller.js';
import type { ControllerNotification } from '#src/providers/claude/appserver/session-contract.js';
import { FakeClaudeChild } from '#tests/helpers/fake-claude-child.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000501';

function failedNotification(
  notifications: readonly ControllerNotification[],
): Extract<ControllerNotification, { method: 'turn/failed' }> | undefined {
  return notifications.find(
    (notification): notification is Extract<ControllerNotification, { method: 'turn/failed' }> =>
      notification.method === 'turn/failed',
  );
}

describe('Claude turn failure diagnostics', () => {
  it('emits child-exit as the broker-layer failure reason when the child exits mid-turn', async () => {
    const child = new FakeClaudeChild();
    const notifications: ControllerNotification[] = [];
    const controller = new SingleSessionController({
      spawnChild: () => child,
      ids: { uuid: () => TEST_SESSION_ID },
      monotonicNow: () => process.hrtime.bigint() / 1_000_000n,
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
});
