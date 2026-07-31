import { describe, expect, it, vi } from 'vitest';

import { PrintSessionController } from '#src/providers/claude/appserver/print-controller.js';
import type {
  ControllerNotification,
  ClaudePrintChild,
  SpawnClaudePrintChildOptions,
} from '#src/providers/claude/appserver/session-contract.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const testControlRequestTimer = {
  schedule(callback: () => void, delayMs: number): unknown {
    return globalThis.setTimeout(callback, delayMs);
  },
  cancel(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

class FakeClaudePrintChild implements ClaudePrintChild {
  readonly writes: string[] = [];
  readonly killedSignals: Array<NodeJS.Signals | undefined> = [];
  readonly failOnWriteIndexes = new Set<number>();
  private readonly stdoutHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(chunk: string) => void>();
  private readonly exitHandlers = new Set<
    (event: { code: number | null; signal: NodeJS.Signals | string | number | null; error?: Error }) => void
  >();

  writeLine(line: string): void {
    if (this.failOnWriteIndexes.has(this.writes.length)) {
      throw new Error(`write ${this.writes.length} failed`);
    }
    this.writes.push(line);
  }

  kill(signal?: NodeJS.Signals): void {
    this.killedSignals.push(signal);
    this.emitExit({ code: null, signal: signal ?? null });
  }

  emitExit(event: { code: number | null; signal: NodeJS.Signals | string | number | null; error?: Error }): void {
    for (const handler of this.exitHandlers) {
      handler(event);
    }
  }

  onStdoutLine(handler: (line: string) => void): () => void {
    this.stdoutHandlers.add(handler);
    return () => {
      this.stdoutHandlers.delete(handler);
    };
  }

  onExit(
    handler: (event: { code: number | null; signal: NodeJS.Signals | string | number | null; error?: Error }) => void,
  ): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  onStderrChunk(handler: (chunk: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => {
      this.stderrHandlers.delete(handler);
    };
  }

  emitStdout(message: unknown): void {
    const line = JSON.stringify(message);
    for (const handler of this.stdoutHandlers) {
      handler(line);
    }
  }

  emitStderr(chunk: string): void {
    for (const handler of this.stderrHandlers) {
      handler(chunk);
    }
  }
}

function parseWrite(child: FakeClaudePrintChild, index: number): Record<string, unknown> {
  return JSON.parse(child.writes[index]) as Record<string, unknown>;
}

async function waitForWrite(child: FakeClaudePrintChild, index: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.writes.length > index) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for print child write ${index}`);
}

function createController(
  child: FakeClaudePrintChild,
  notifications: ControllerNotification[] = [],
  options: {
    controlRequestTimeoutMs?: number;
    onSpawn?: (spawnOptions: SpawnClaudePrintChildOptions) => void;
  } = {},
) {
  return createControllerFromChildren([child], notifications, options);
}

function createControllerFromChildren(
  children: FakeClaudePrintChild[],
  notifications: ControllerNotification[] = [],
  options: {
    controlRequestTimeoutMs?: number;
    onSpawn?: (spawnOptions: SpawnClaudePrintChildOptions) => void;
  } = {},
) {
  let spawnIndex = 0;
  let requestIndex = 0;
  const { onSpawn, ...controllerOptions } = options;
  const controller = new PrintSessionController({
    spawnChild: (spawnOptions) => {
      onSpawn?.(spawnOptions);
      const child = children[spawnIndex];
      spawnIndex += 1;
      if (!child) {
        throw new Error('No fake Claude print child available.');
      }
      return child;
    },
    ids: {
      uuid: () => {
        requestIndex += 1;
        return `uuid-${requestIndex}`;
      },
    },
    now: () => 1_000,
    controlRequestTimer: testControlRequestTimer,
    ...controllerOptions,
  });
  controller.subscribeNotifications((notification) => {
    notifications.push(notification);
  });
  return controller;
}

async function ensureController(
  controller: PrintSessionController,
  child: FakeClaudePrintChild,
  permissionMode: 'default' | 'bypassPermissions' = 'default',
  overrides: { conversationRef?: string; resumeExisting?: boolean } = {},
) {
  const ensure = controller.sessionEnsure({
    cwd: '/workspace',
    projectsRoot: '/tmp/coral-test-home/.claude/projects',
    systemPromptHash: 'sha256:test',

    bootstrapConfigHash: 'sha256:test-bootstrap',
    permissionMode,
    systemPrompt: 'system',
    model: 'claude-sonnet-test',
    effort: 'high',
    ...overrides,
  });
  await waitForWrite(child, 0);

  const initRequest = parseWrite(child, 0);
  expect(initRequest).toMatchObject({
    type: 'control_request',
    request: { subtype: 'initialize' },
  });
  expect(initRequest.request).not.toHaveProperty('systemPrompt');

  child.emitStdout({
    type: 'system',
    subtype: 'init',
    session_id: overrides.conversationRef ?? TEST_SESSION_ID,
    model: 'claude-sonnet-test',
  });
  child.emitStdout({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: initRequest.request_id,
      response: {},
    },
  });

  return ensure;
}

describe('PrintSessionController', () => {
  it.each([
    ['new', false],
    ['resumed', true],
  ] as const)('passes %s-session intent to the print child', async (_label, resumeExisting) => {
    const child = new FakeClaudePrintChild();
    const spawnOptions: SpawnClaudePrintChildOptions[] = [];
    const controller = createController(child, [], {
      onSpawn: (options) => spawnOptions.push(options),
    });

    await expect(
      ensureController(controller, child, 'default', {
        conversationRef: TEST_SESSION_ID,
        resumeExisting,
      }),
    ).resolves.toMatchObject({ conversationRef: TEST_SESSION_ID });
    expect(spawnOptions).toHaveLength(1);
    expect(spawnOptions[0]).toMatchObject({
      conversationRef: TEST_SESSION_ID,
      resume: resumeExisting,
    });

    await controller.shutdown();
  });

  it('bootstraps with a control request, sends user JSONL, and completes from result output', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);

    await expect(ensureController(controller, child)).resolves.toMatchObject({
      sessionId: TEST_SESSION_ID,
      conversationRef: TEST_SESSION_ID,
      initialized: true,
    });

    await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
    expect(parseWrite(child, 1)).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      session_id: TEST_SESSION_ID,
    });

    child.emitStdout({
      type: 'result',
      subtype: 'success',
      session_id: TEST_SESSION_ID,
      result: 'done',
      duration_ms: 12,
      num_turns: 1,
      total_cost_usd: 0.02,
      usage: { input_tokens: 3 },
      is_error: false,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          sessionId: TEST_SESSION_ID,
          conversationRef: TEST_SESSION_ID,
          result: 'done',
          model: 'claude-sonnet-test',
          durationMs: 12,
          costUsd: 0.02,
          isError: false,
        }),
      }),
    );

    await controller.shutdown();
  });

  it('auto-allows print-mode permission requests when permissions are bypassed', async () => {
    const child = new FakeClaudePrintChild();
    const controller = createController(child);

    await ensureController(controller, child, 'bypassPermissions');
    await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'read file' });

    child.emitStdout({
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { file_path: '/workspace/a.txt' },
      },
    });

    expect(parseWrite(child, 2)).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'permission-1',
        response: { behavior: 'allow' },
      },
    });

    await controller.shutdown();
  });

  it('denies permission requests in non-auto permission modes without dropping the active turn', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);

    await ensureController(controller, child, 'default');
    await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'edit file' });

    child.emitStdout({
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        input: { file_path: '/workspace/a.txt' },
      },
    });

    expect(parseWrite(child, 2)).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'permission-1',
        response: { behavior: 'deny' },
      },
    });
    expect(controller.hasActiveTurn()).toBe(true);

    child.emitStdout({
      type: 'result',
      subtype: 'success',
      session_id: TEST_SESSION_ID,
      result: 'permission denied',
      is_error: false,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          result: 'permission denied',
        }),
      }),
    );

    await controller.shutdown();
  });

  it('fails and frees the active turn when a permission response cannot be written', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);

    await ensureController(controller, child, 'bypassPermissions');
    await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'read file' });
    child.failOnWriteIndexes.add(2);

    child.emitStdout({
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { file_path: '/workspace/a.txt' },
      },
    });

    expect(controller.hasActiveTurn()).toBe(false);
    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/failed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          diagnostic: expect.objectContaining({ reason: 'internal-error' }),
        }),
      }),
    );

    await controller.shutdown();
  });

  it('uses a late system init model for the active turn completion', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);

    const ensure = controller.sessionEnsure({
      cwd: '/workspace',
      projectsRoot: '/tmp/coral-test-home/.claude/projects',
      systemPromptHash: 'sha256:test',

      bootstrapConfigHash: 'sha256:test-bootstrap',
      permissionMode: 'default',
      systemPrompt: 'system',
      effort: 'high',
    });
    await waitForWrite(child, 0);
    const initRequest = parseWrite(child, 0);
    child.emitStdout({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: initRequest.request_id,
        response: {},
      },
    });
    await ensure;

    await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
    child.emitStdout({
      type: 'system',
      subtype: 'init',
      session_id: TEST_SESSION_ID,
      model: 'claude-late-model',
    });
    child.emitStdout({
      type: 'result',
      subtype: 'success',
      session_id: TEST_SESSION_ID,
      result: 'done',
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({
          brokerTurnId: 'turn-1',
          model: 'claude-late-model',
        }),
      }),
    );

    await controller.shutdown();
  });

  it('times out an unanswered initialize control request and resets initial bootstrap state', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeClaudePrintChild();
      const controller = createController(child, [], { controlRequestTimeoutMs: 5 });

      const ensure = controller.sessionEnsure({
        cwd: '/workspace',
        projectsRoot: '/tmp/coral-test-home/.claude/projects',
        systemPromptHash: 'sha256:test',

        bootstrapConfigHash: 'sha256:test-bootstrap',
        permissionMode: 'default',
        systemPrompt: 'system',
        effort: 'high',
      });
      const rejected = expect(ensure).rejects.toThrow(/timed out after 5ms/);
      await waitForWrite(child, 0);
      await vi.advanceTimersByTimeAsync(5);

      await rejected;
      expect(child.killedSignals).toContain('SIGTERM');
      expect(controller.hasLiveController()).toBe(false);
      await expect(controller.sessionProbe()).resolves.toMatchObject({
        status: 'missing',
        sessionId: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a failed rebootstrap child after an established session', async () => {
    const firstChild = new FakeClaudePrintChild();
    const secondChild = new FakeClaudePrintChild();
    const controller = createControllerFromChildren([firstChild, secondChild]);

    await ensureController(controller, firstChild);
    firstChild.emitExit({ code: 0, signal: null });
    expect(controller.hasLiveController()).toBe(false);

    const ensure = controller.sessionEnsure({
      cwd: '/workspace',
      projectsRoot: '/tmp/coral-test-home/.claude/projects',
      systemPromptHash: 'sha256:test',

      bootstrapConfigHash: 'sha256:test-bootstrap',
      permissionMode: 'default',
      systemPrompt: 'system',
      model: 'claude-sonnet-test',
      effort: 'high',
    });
    await waitForWrite(secondChild, 0);
    const initRequest = parseWrite(secondChild, 0);

    secondChild.emitStdout({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: initRequest.request_id,
        error: 'rebootstrap failed',
      },
    });

    await expect(ensure).rejects.toThrow(/rebootstrap failed/);
    expect(secondChild.killedSignals).toContain('SIGTERM');
    expect(controller.hasLiveController()).toBe(false);
    await expect(controller.sessionProbe()).resolves.toMatchObject({
      status: 'unavailable',
      sessionId: TEST_SESSION_ID,
    });
  });
});
