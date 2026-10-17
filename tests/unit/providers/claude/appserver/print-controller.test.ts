import { describe, expect, it, vi } from 'vitest';

import { PrintSessionController } from '#src/providers/claude/appserver/print-controller.js';
import { createBrokerSession } from '#src/providers/claude/appserver/broker-pool.js';
import { ClaudeBrokerSendUnansweredError } from '#src/providers/claude/appserver/protocol.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';
import { claudeSessionKernel } from '#src/providers/claude/session-kernel.js';
import type {
  ControllerNotification,
  ClaudePrintChild,
  SpawnClaudePrintChildOptions,
} from '#src/providers/claude/appserver/session-contract.js';
import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderRequest,
  ProviderSteeringPort,
} from '#src/providers/contract.js';
import type { ClaudeExecutionPlan } from '#src/providers/claude/execution-plan.js';
import { collectProviderEvents } from '#src/providers/stream.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_CLAUDE_PLAN } from '../../../../helpers/provider-credentials.js';

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
  exitOnKill = true;
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
    if (this.exitOnKill) this.emitExit({ code: null, signal: signal ?? null });
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
        return `00000000-0000-4000-8000-${String(requestIndex).padStart(12, '0')}`;
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
  const firstSendId = '22222222-2222-4222-8222-222222222222';
  const secondSendId = '33333333-3333-4333-8333-333333333333';
  const replay = (uuid: unknown, content = 'same message') => ({
    type: 'user',
    message: { role: 'user', content },
    session_id: TEST_SESSION_ID,
    parent_tool_use_id: null,
    uuid,
    timestamp: '2026-10-17T14:14:45.813Z',
    isReplay: true,
  });
  const result = {
    type: 'result',
    subtype: 'success',
    session_id: TEST_SESSION_ID,
    result: 'DONE',
    is_error: false,
    duration_ms: 500,
    num_turns: 2,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 2 },
  };

  it('correlates absorbed sends by UUID, ignores initial and tool-result echoes, and completes once', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'same message' });
      const initial = parseWrite(child, 1);
      expect(initial.uuid).toEqual(expect.any(String));
      expect(initial.uuid).not.toBe(firstSendId);
      await expect(
        controller.turnSend({ brokerTurnId: 'turn-1', text: 'same message', clientMessageId: String(initial.uuid) }),
      ).resolves.toMatchObject({ state: 'refused', code: 'provider_rejected' });
      await expect(
        controller.turnSend({ brokerTurnId: 'other-turn', text: 'same message', clientMessageId: firstSendId }),
      ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
      expect(child.writes).toHaveLength(2);
      await expect(
        controller.turnSend({ brokerTurnId: 'turn-1', text: 'same message', clientMessageId: firstSendId }),
      ).resolves.toEqual({ state: 'delivered' });
      await controller.turnSend({ brokerTurnId: 'turn-1', text: 'same message', clientMessageId: secondSendId });
      expect(parseWrite(child, 2)).toMatchObject({
        type: 'user',
        uuid: firstSendId,
        message: { role: 'user', content: 'same message' },
      });
      expect(parseWrite(child, 3)).toMatchObject({ uuid: secondSendId });

      child.emitStdout(replay(initial.uuid));
      child.emitStdout(replay('44444444-4444-4444-8444-444444444444'));
      child.emitStdout({
        ...replay(firstSendId),
        isReplay: undefined,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
      });
      expect(notifications.filter((n) => n.method === 'turn/progress')).toEqual([]);
      child.emitStdout(replay(secondSendId));
      child.emitStdout(replay(secondSendId));
      expect(notifications.filter((n) => n.method === 'turn/progress').map((n) => n.params.message)).toEqual([
        `Sent message ${secondSendId} read by the agent`,
      ]);
      child.emitStdout(replay(firstSendId));
      child.emitStdout(result);
      child.emitStdout(result);

      const completions = notifications.filter((n) => n.method === 'turn/completed');
      expect(completions).toHaveLength(1);
      expect(completions[0].params).toMatchObject({
        result: 'DONE',
        durationMs: 500,
        numTurns: 2,
        costUsd: 0.01,
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      expect(notifications.filter((n) => n.method === 'turn/progress').map((n) => n.params.message)).toEqual([
        `Sent message ${secondSendId} read by the agent`,
        `Sent message ${firstSendId} read by the agent`,
      ]);
      expect(notifications.at(-1)?.method).toBe('turn/completed');
      expect(child.writes).toHaveLength(4);
      expect(controller.hasActiveTurn()).toBe(false);
    } finally {
      await controller.shutdown();
    }
  });

  it('preserves the no-send result and accounting when the initial prompt is replayed', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      child.emitStdout(replay(parseWrite(child, 1).uuid, 'hello'));
      child.emitStdout(result);
      expect(notifications.map((n) => n.method)).toEqual(['session/updated', 'turn/completed']);
      expect(notifications.at(-1)?.params).toMatchObject({
        result: 'DONE',
        durationMs: 500,
        numTurns: 2,
        costUsd: 0.01,
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      expect(child.writes).toHaveLength(2);
    } finally {
      await controller.shutdown();
    }
  });

  it('retains a possibly written send for replay correlation without claiming refusal or retrying it', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      child.failOnWriteIndexes.add(2);
      await expect(
        controller.turnSend({ brokerTurnId: 'turn-1', text: 'same message', clientMessageId: firstSendId }),
      ).rejects.toBeInstanceOf(ClaudeBrokerSendUnansweredError);
      expect(child.writes).toHaveLength(2);
      expect(child.killedSignals).toEqual([]);
      child.emitStdout(replay(firstSendId));
      child.emitStdout(result);
      expect(notifications.filter((n) => n.method === 'turn/progress').map((n) => n.params.message)).toEqual([
        `Sent message ${firstSendId} read by the agent`,
      ]);
      expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
    } finally {
      await controller.shutdown();
    }
  });

  it('carries an absorbed send through the facet, broker pool, stdout parser and kernel before one terminal', async () => {
    const child = new FakeClaudePrintChild();
    let nextId = 0;
    const spawnChild = vi.fn(() => child);
    const broker = createBrokerSession({
      spawnChild,
      ids: { uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
      monotonicNow: () => 0n,
      createController: (options) =>
        new PrintSessionController({ ...options, now: () => 1_000, controlRequestTimer: testControlRequestTimer }),
    });
    const lease: AppServerSession = {
      rpc: (async (method, params) => {
        if (method === 'session/ensure')
          return broker.sessionEnsure(params as unknown as Parameters<typeof broker.sessionEnsure>[0]);
        if (method === 'turn/start')
          return broker.turnStart(params as unknown as Parameters<typeof broker.turnStart>[0]);
        if (method === 'turn/send') return broker.turnSend(params as unknown as Parameters<typeof broker.turnSend>[0]);
        throw new Error(`Unexpected RPC: ${method}`);
      }) as AppServerSession['rpc'],
      subscribe: (handler) =>
        broker.subscribeNotifications((n) => handler({ method: n.method, params: { ...n.params } })),
      closed: broker.closed,
      interrupt: async () => ({ kind: 'not-accepted', reason: 'unused' }),
    };
    let steering!: ProviderSteeringPort;
    let continuity: Record<string, unknown> = {};
    const onProviderTurnTerminal = vi.fn();
    const runtime: ProviderAppServerRuntime<ClaudeExecutionPlan> = {
      transport: 'app-server',
      signal: new AbortController().signal,
      appServerSession: lease,
      time: {
        now: () => 1_000,
        setTimeout: () => ({ unref: () => {} }),
        clearTimeout: () => {},
      } as ProviderAppServerRuntime<ClaudeExecutionPlan>['time'],
      storage: {
        existsSync: () => false,
        readFileSync: () => '',
        statSync: () => ({}),
        readdirSync: () => [],
      } as unknown as ProviderAppServerRuntime<ClaudeExecutionPlan>['storage'],
      ids: { uuid: () => 'turn-1', sha256: () => 'sha256:test' },
      continuityBridge: {
        checkpoint: (update) => {
          continuity = update.providerContinuity ?? {};
        },
        transportClosed: vi.fn(),
      },
      onProviderSteering: (port) => {
        steering = port;
      },
      onProviderTurnTerminal,
      kbRoot: '/mock/kb',
      executionPlan: TEST_CLAUDE_PLAN,
    };
    const request: ProviderRequest = {
      action: 'exec',
      sessionId: TEST_SESSION_ID,
      name: 'claude',
      prompt: 'hello',
      cwd: fixtureCanonicalWorkDir('/workspace'),
      bypassPermissions: false,
      coralEnv: {},
    };
    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(request, runtime));
      await waitForWrite(child, 0);
      expect(steering.admit({}, firstSendId)).toMatchObject({ state: 'refused', code: 'turn_not_started' });
      child.emitStdout({
        type: 'control_response',
        response: { subtype: 'success', request_id: parseWrite(child, 0).request_id, response: {} },
      });
      await waitForWrite(child, 1);
      expect(steering.admit({ ...continuity, brokerTurnId: 'other-turn' }, firstSendId)).toMatchObject({
        state: 'refused',
        code: 'turn_not_started',
      });
      await vi.waitFor(() => expect(steering.admit(continuity, firstSendId)).toEqual({ state: 'admitted' }));
      await expect(
        broker.turnSend({
          brokerSessionKey: 'other-session',
          brokerTurnId: 'turn-1',
          text: 'same message',
          clientMessageId: firstSendId,
        }),
      ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
      expect(child.writes).toHaveLength(2);
      expect(spawnChild).toHaveBeenCalledTimes(1);
      const delivered = await claudeAppServerLifecycle.send!(lease, continuity, {
        text: 'same message',
        clientMessageId: firstSendId,
      });
      expect(delivered).toEqual({ state: 'delivered' });
      steering.reportOutcome(firstSendId, delivered);
      child.emitStdout(replay(parseWrite(child, 1).uuid, 'hello'));
      child.emitStdout(replay(firstSendId));
      child.emitStdout(result);
      const events = await eventsPromise;
      const read = events.findIndex(
        (event) => event.kind === 'progress' && event.message === `Sent message ${firstSendId} read by the agent`,
      );
      const terminals = events.filter((event) => event.kind === 'terminal');
      expect(read).toBeGreaterThanOrEqual(0);
      expect(
        events.filter((event) => event.kind === 'progress' && event.message.includes('read by the agent')),
      ).toHaveLength(1);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        terminal: {
          content: 'DONE',
          durationMs: 500,
          outcome: { kind: 'completed' },
          usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
        },
      });
      expect(events.indexOf(terminals[0])).toBeGreaterThan(read);
      expect(onProviderTurnTerminal).toHaveBeenCalledExactlyOnceWith({
        kind: 'provider-turn-terminal',
        providerTurnId: 'turn-1',
        status: 'completed',
      });
      expect(steering.admit(continuity, secondSendId)).toMatchObject({ state: 'refused', code: 'turn_ended' });
      expect(child.writes).toHaveLength(3);
      expect(child.killedSignals).not.toContain('SIGKILL');
    } finally {
      await broker.shutdown();
    }
  });

  it.each([['resumed', true]] as const)(
    'passes %s-session intent to the print child',
    async (_label, resumeExisting) => {
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
    },
  );

  it('keeps the controller turn active after interrupt acknowledgement and emits evidence only after result', async () => {
    const child = new FakeClaudePrintChild();
    const controller = createController(child);
    const abortController = new AbortController();
    const onProviderTurnTerminal = vi.fn();
    const lifecycleInterrupt = claudeAppServerLifecycle.interrupt;
    if (lifecycleInterrupt === undefined) {
      throw new Error('Claude app-server lifecycle does not support interruption.');
    }
    let notificationHandler: Parameters<AppServerSession['subscribe']>[0] | null = null;
    let resolveInterruptAcknowledged!: () => void;
    const interruptAcknowledged = new Promise<void>((resolve) => {
      resolveInterruptAcknowledged = resolve;
    });

    const lease: AppServerSession = {
      rpc: (async (method: string, params: Record<string, unknown>) => {
        const { brokerSessionKey: _brokerSessionKey, ...controllerParams } = params;
        if (method === 'session/ensure') {
          return {
            ...(await controller.sessionEnsure(controllerParams as Parameters<typeof controller.sessionEnsure>[0])),
            brokerSessionKey: 'broker-1',
          };
        }
        if (method === 'turn/start') {
          return {
            ...(await controller.turnStart(controllerParams as Parameters<typeof controller.turnStart>[0])),
            brokerSessionKey: 'broker-1',
          };
        }
        if (method === 'turn/interrupt') {
          return controller.turnInterrupt(controllerParams as Parameters<typeof controller.turnInterrupt>[0]);
        }
        throw new Error(`Unexpected controller-spanning RPC: ${method}`);
      }) as AppServerSession['rpc'],
      subscribe(handler) {
        notificationHandler = handler;
        return controller.subscribeNotifications((notification) => {
          notificationHandler?.({
            method: notification.method,
            params: { brokerSessionKey: 'broker-1', ...notification.params },
          });
        });
      },
      closed: new Promise(() => {}),
      async interrupt(continuity) {
        const outcome = await lifecycleInterrupt(lease, continuity);
        resolveInterruptAcknowledged();
        return outcome;
      },
    };
    const request: ProviderRequest = {
      action: 'exec',
      sessionId: TEST_SESSION_ID,
      name: 'claude',
      prompt: 'hello',
      cwd: fixtureCanonicalWorkDir('/workspace'),
      bypassPermissions: false,
      coralEnv: {},
    };
    const runtime: ProviderAppServerRuntime<ClaudeExecutionPlan> = {
      transport: 'app-server',
      signal: abortController.signal,
      appServerSession: lease,
      time: {
        now: () => 1_000,
        setTimeout: () => ({ unref: () => {} }),
        clearTimeout: () => {},
      } as ProviderAppServerRuntime<ClaudeExecutionPlan>['time'],
      storage: {
        existsSync: () => false,
        readFileSync: () => '',
        statSync: () => ({}),
        readdirSync: () => [],
      } as unknown as ProviderAppServerRuntime<ClaudeExecutionPlan>['storage'],
      ids: { uuid: () => 'turn-1', sha256: () => 'sha256:test' },
      continuityBridge: { checkpoint: vi.fn(), transportClosed: vi.fn() },
      onProviderTurnTerminal,
      kbRoot: '/mock/kb',
      executionPlan: TEST_CLAUDE_PLAN,
    };

    try {
      const eventsPromise = collectProviderEvents(claudeSessionKernel(request, runtime));
      await waitForWrite(child, 0);
      const initRequest = parseWrite(child, 0);
      child.emitStdout({
        type: 'system',
        subtype: 'init',
        session_id: TEST_SESSION_ID,
        model: 'claude-sonnet-test',
      });
      child.emitStdout({
        type: 'control_response',
        response: { subtype: 'success', request_id: initRequest.request_id, response: {} },
      });
      await waitForWrite(child, 1);
      expect(controller.hasActiveTurn()).toBe(true);

      abortController.abort();
      await waitForWrite(child, 2);
      const interruptRequest = parseWrite(child, 2);
      expect(interruptRequest).toMatchObject({
        type: 'control_request',
        request: { subtype: 'interrupt' },
      });
      child.emitStdout({
        type: 'control_response',
        response: { subtype: 'success', request_id: interruptRequest.request_id, response: {} },
      });
      await interruptAcknowledged;

      expect(controller.hasActiveTurn()).toBe(true);
      expect(onProviderTurnTerminal).not.toHaveBeenCalled();

      child.emitStdout({
        type: 'result',
        subtype: 'success',
        session_id: TEST_SESSION_ID,
        result: 'interrupted result',
        is_error: false,
      });

      expect(controller.hasActiveTurn()).toBe(false);
      await expect(eventsPromise).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'terminal',
            terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'signal_abort' } }),
          }),
        ]),
      );
      expect(onProviderTurnTerminal).toHaveBeenCalledOnce();
      expect(onProviderTurnTerminal).toHaveBeenCalledWith({
        kind: 'provider-turn-terminal',
        providerTurnId: 'turn-1',
        status: 'completed',
      });
    } finally {
      await controller.shutdown();
    }
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

  it('retains a failed bootstrap child until a close event settles cooperative cleanup', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeClaudePrintChild();
      child.exitOnKill = false;
      const controller = createController(child, [], { controlRequestTimeoutMs: 5 });

      const ensure = controller.sessionEnsure({
        cwd: '/workspace',
        projectsRoot: '/tmp/coral-test-home/.claude/projects',
        systemPromptHash: 'sha256:test',
        bootstrapConfigHash: 'sha256:test-bootstrap',
        permissionMode: 'default',
      });
      const rejected = expect(ensure).rejects.toThrow(/timed out after 5ms/);
      await waitForWrite(child, 0);
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(2_500);

      await rejected;
      expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(controller.hasLiveController()).toBe(true);

      child.emitExit({ code: null, signal: 'SIGKILL' });
      await Promise.resolve();
      expect(controller.hasLiveController()).toBe(false);
      await expect(controller.sessionProbe()).resolves.toMatchObject({ status: 'missing' });
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
