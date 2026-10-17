import { readFileSync } from 'node:fs';
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
  PrintSessionControllerOptions,
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
    onShutdownHeld?: PrintSessionControllerOptions['onShutdownHeld'];
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
    onShutdownHeld?: PrintSessionControllerOptions['onShutdownHeld'];
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

async function startKernelThroughPool(child: FakeClaudePrintChild) {
  let nextId = 0;
  const spawnChild = vi.fn(() => child);
  const broker = createBrokerSession({
    spawnChild,
    ids: { uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
    monotonicNow: () => 0n,
    createController: (options) =>
      new PrintSessionController({ ...options, now: () => 1_000, controlRequestTimer: testControlRequestTimer }),
  });
  const abort = new AbortController();
  let continuity: Record<string, unknown> = {};
  let steering!: ProviderSteeringPort;
  const lease: AppServerSession = {
    rpc: (async (method, params) => {
      if (method === 'session/ensure')
        return broker.sessionEnsure(params as unknown as Parameters<typeof broker.sessionEnsure>[0]);
      if (method === 'turn/start') return broker.turnStart(params as unknown as Parameters<typeof broker.turnStart>[0]);
      throw new Error(`Unexpected RPC: ${method}`);
    }) as AppServerSession['rpc'],
    subscribe: (handler) =>
      broker.subscribeNotifications((n) => handler({ method: n.method, params: { ...n.params } })),
    closed: broker.closed,
    interrupt: async (ref) => {
      const result = await broker.turnInterrupt({
        brokerSessionKey: String(ref.brokerSessionKey),
        brokerTurnId: String(ref.brokerTurnId),
      });
      return result.interrupted ? { kind: 'accepted' } : { kind: 'not-accepted', reason: 'not-active' };
    },
  };
  const onProviderTurnTerminal = vi.fn();
  const runtime: ProviderAppServerRuntime<ClaudeExecutionPlan> = {
    transport: 'app-server',
    signal: abort.signal,
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
    onProviderTurnTerminal,
    onProviderSteering: (port) => {
      steering = port;
    },
    kbRoot: '/mock/kb',
    executionPlan: TEST_CLAUDE_PLAN,
  };
  const events = collectProviderEvents(
    claudeSessionKernel(
      {
        action: 'exec',
        sessionId: TEST_SESSION_ID,
        name: 'claude',
        prompt: 'hello',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {},
      },
      runtime,
    ),
  );
  await waitForWrite(child, 0);
  child.emitStdout({ type: 'system', subtype: 'init', session_id: TEST_SESSION_ID, model: 'haiku' });
  child.emitStdout({
    type: 'control_response',
    response: { subtype: 'success', request_id: parseWrite(child, 0).request_id, response: {} },
  });
  await waitForWrite(child, 1);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return {
    broker,
    abort,
    events,
    spawnChild,
    onProviderTurnTerminal,
    steering,
    get continuity() {
      return continuity;
    },
    send: (clientMessageId: string) =>
      broker.turnSend({
        brokerSessionKey: String(continuity.brokerSessionKey),
        brokerTurnId: 'turn-1',
        text: 'late',
        clientMessageId,
      }),
  };
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

  it('refuses sends to either of two completed turns and unknown IDs as turn_ended without writing', async () => {
    const child = new FakeClaudePrintChild();
    const controller = createController(child);
    const send = { brokerTurnId: 'turn-1', text: 'hello', clientMessageId: firstSendId };
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      child.emitStdout(result);
      await controller.turnStart({ brokerTurnId: 'turn-2', prompt: 'hello again' });
      child.emitStdout(result);
      await expect(controller.turnSend(send)).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
      await expect(controller.turnSend({ ...send, brokerTurnId: 'turn-2' })).resolves.toMatchObject({
        state: 'refused',
        code: 'turn_ended',
      });
      await expect(controller.turnSend({ ...send, brokerTurnId: 'unknown-turn' })).resolves.toMatchObject({
        state: 'refused',
        code: 'turn_ended',
      });
      expect(child.writes).toHaveLength(3);
    } finally {
      await controller.shutdown();
    }
  });

  it('refuses a known turn before its initial prompt write completes as turn_not_started', async () => {
    const child = new FakeClaudePrintChild();
    const controller = createController(child);
    try {
      await ensureController(controller, child);
      let send: ReturnType<PrintSessionController['turnSend']> | undefined;
      const writeLine = child.writeLine.bind(child);
      vi.spyOn(child, 'writeLine').mockImplementationOnce((line) => {
        send = controller.turnSend({ brokerTurnId: 'turn-1', text: 'too early', clientMessageId: firstSendId });
        writeLine(line);
      });
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      await expect(send).resolves.toMatchObject({ state: 'refused', code: 'turn_not_started' });
      expect(child.writes).toHaveLength(2);
      child.emitStdout(result);
    } finally {
      await controller.shutdown();
    }
  });

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
        'Claude aggregate: 1 result segments; turns=2',
      ]);
      expect(notifications.at(-1)?.method).toBe('turn/completed');
      expect(child.writes).toHaveLength(4);
      expect(controller.hasActiveTurn()).toBe(false);
    } finally {
      await controller.shutdown();
    }
  });

  const separator = '\n\n--- Message sent while the agent was finishing (jobs send) ---\n';
  const finalResult = {
    ...result,
    result: 'FOLLOW_ON',
    duration_ms: 700,
    num_turns: 3,
    total_cost_usd: 0.03,
    usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
  const firstResult = {
    ...result,
    usage: { ...result.usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };

  it('replays the pinned Haiku follow-on and accounts for each field using its measured semantics', async () => {
    const frames = readFileSync(new URL('./fixtures/haiku-follow-on-2.1.302.jsonl', import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'count' });
      let sent = false;
      let results = 0;
      for (const frame of frames) {
        if (frame.type === 'assistant' && !sent) {
          await controller.turnSend({ brokerTurnId: 'turn-1', text: 'FOLLOW_ON_OK', clientMessageId: firstSendId });
          sent = true;
        }
        child.emitStdout(frame);
        if (frame.type === 'result' && ++results === 1) {
          expect(controller.hasActiveTurn()).toBe(true);
          expect(notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);
          await expect(
            controller.turnSend({ brokerTurnId: 'turn-1', text: 'gap', clientMessageId: secondSendId }),
          ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
        }
      }
      const completions = notifications.filter((n) => n.method === 'turn/completed');
      expect(completions).toHaveLength(1);
      const rawResults = frames.filter((frame) => frame.type === 'result');
      expect(completions[0].params).toMatchObject({
        result: `${rawResults[0].result}${separator}FOLLOW_ON_OK`,
        usage: {
          input_tokens: 4,
          output_tokens: 135,
          cache_creation_input_tokens: 3439,
          cache_read_input_tokens: 3884,
        },
        costUsd: 0.00079454,
        numTurns: 2,
        durationMs: 1776,
        isError: false,
        subtype: 'success',
      });
      expect(notifications.at(-2)?.params).toMatchObject({ message: 'Claude aggregate: 2 result segments; turns=2' });
      expect(child.killedSignals).toEqual([]);
    } finally {
      await controller.shutdown();
    }
  });

  it.each([false, true])(
    'includes the final segment exactly once and uses its failure=%s outcome and errors',
    async (fails) => {
      const child = new FakeClaudePrintChild();
      const notifications: ControllerNotification[] = [];
      const controller = createController(child, notifications);
      try {
        await ensureController(controller, child);
        await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
        await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
        child.emitStdout({ ...firstResult, errors: ['old error'] });
        child.emitStdout(replay(firstSendId));
        const final = {
          ...finalResult,
          is_error: fails,
          subtype: fails ? 'error_during_execution' : 'success',
          errors: fails ? ['final error'] : [],
        };
        child.emitStdout(final);
        child.emitStdout(final);
        const completions = notifications.filter((n) => n.method === 'turn/completed');
        expect(completions).toHaveLength(1);
        expect(completions[0].params).toMatchObject({
          result: `DONE${separator}FOLLOW_ON`,
          isError: fails,
          errors: fails ? ['final error'] : [],
          subtype: final.subtype,
          usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          numTurns: 5,
          durationMs: 1200,
        });
        expect(completions[0].params.costUsd).toBeCloseTo(0.03);
        expect(notifications.at(-2)?.params).toMatchObject({ message: 'Claude aggregate: 2 result segments; turns=5' });
      } finally {
        await controller.shutdown();
      }
    },
  );

  it.each(['init', 'assistant', 'replay'] as const)(
    'chains two late sends and opens eligibility only on %s activity',
    async (activity) => {
      const child = new FakeClaudePrintChild();
      const notifications: ControllerNotification[] = [];
      const controller = createController(child, notifications);
      try {
        await ensureController(controller, child);
        await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
        await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late 1', clientMessageId: firstSendId });
        child.emitStdout(firstResult);
        for (const frame of [
          { type: 'keep_alive' },
          { type: 'system', subtype: 'status', status: 'busy' },
          { type: 'system', subtype: 'init', model: 42 },
          { type: 'assistant', message: {} },
          { ...replay(secondSendId), isReplay: false },
          replay(parseWrite(child, 1).uuid),
          {
            ...replay(firstSendId),
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
            },
          },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] } },
        ])
          child.emitStdout(frame);
        await expect(
          controller.turnSend({ brokerTurnId: 'turn-1', text: 'gap', clientMessageId: secondSendId }),
        ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
        expect(child.writes).toHaveLength(3);
        expect(
          notifications.filter((n) => n.method === 'turn/progress' && n.params.message.includes('read by the agent')),
        ).toEqual([]);
        child.emitStdout(
          activity === 'init'
            ? { type: 'system', subtype: 'init', session_id: TEST_SESSION_ID, model: 'haiku' }
            : activity === 'assistant'
              ? { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }
              : replay(firstSendId),
        );
        await expect(
          controller.turnSend({ brokerTurnId: 'turn-1', text: 'late 2', clientMessageId: secondSendId }),
        ).resolves.toEqual({ state: 'delivered' });
        child.emitStdout(replay(firstSendId));
        child.emitStdout(finalResult);
        expect(notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);
        await expect(
          controller.turnSend({
            brokerTurnId: 'turn-1',
            text: 'gap again',
            clientMessageId: '44444444-4444-4444-8444-444444444444',
          }),
        ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
        child.emitStdout(replay(secondSendId));
        child.emitStdout({ ...finalResult, result: 'THIRD', total_cost_usd: 0.05 });
        expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
        expect(notifications.at(-1)?.params).toMatchObject({
          brokerTurnId: 'turn-1',
          result: `DONE${separator}FOLLOW_ON${separator}THIRD`,
          usage: { input_tokens: 50, output_tokens: 8 },
          costUsd: 0.05,
          numTurns: 8,
          durationMs: 1900,
        });
      } finally {
        await controller.shutdown();
      }
    },
  );

  it('keeps missing totals unavailable component-wise and preserves zero counters', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
      child.emitStdout({
        ...firstResult,
        usage: { output_tokens: 0, cache_read_input_tokens: 0 },
        num_turns: undefined,
        total_cost_usd: undefined,
        duration_ms: undefined,
      });
      child.emitStdout(replay(firstSendId));
      child.emitStdout({
        ...finalResult,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
        num_turns: 0,
        duration_ms: 0,
        total_cost_usd: 0,
      });
      expect(notifications.at(-1)?.params).toMatchObject({
        usage: { output_tokens: 0, cache_read_input_tokens: 0 },
        costUsd: null,
        numTurns: null,
        durationMs: null,
      });
      const terminal = notifications.find((n) => n.method === 'turn/completed');
      expect(terminal?.params.usage).not.toHaveProperty('input_tokens');
      expect(terminal?.params.usage).not.toHaveProperty('cache_creation_input_tokens');
      expect(notifications.at(-2)?.params).toMatchObject({
        message: 'Claude aggregate: 2 result segments; turns=unavailable',
      });
    } finally {
      await controller.shutdown();
    }
  });

  it.each([false, true])(
    'owns deadline cleanup until child absence and retains last segment failure=%s',
    async (fails) => {
      vi.useFakeTimers();
      const child = new FakeClaudePrintChild();
      child.exitOnKill = false;
      const notifications: ControllerNotification[] = [];
      const controller = createController(child, notifications);
      try {
        await ensureController(controller, child);
        await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
        await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
        child.emitStdout({ ...firstResult, is_error: fails, errors: fails ? ['last segment error'] : [] });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(child.killedSignals).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(child.killedSignals).toEqual(['SIGTERM']);
        await vi.advanceTimersByTimeAsync(2_500);
        expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(controller.hasActiveTurn()).toBe(true);
        expect(notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);
        await expect(
          controller.turnSend({ brokerTurnId: 'turn-1', text: 'stopping', clientMessageId: secondSendId }),
        ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await vi.advanceTimersByTimeAsync(0);
        expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
        expect(notifications.at(-1)?.params).toMatchObject({
          result: 'DONE',
          isError: fails,
          errors: fails ? ['last segment error'] : [],
          durationMs: 500,
        });
        expect(notifications.filter((n) => n.method === 'turn/progress').map((n) => n.params.message)).toContain(
          `Sent message ${firstSendId} was not read: the follow-up turn did not start`,
        );
        expect(controller.hasActiveTurn()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await controller.shutdown();
        vi.useRealTimers();
      }
    },
  );

  it.each(['gap', 'active'] as const)(
    'cancels a pending send in the %s without late replay or result bypassing cleanup',
    async (phase) => {
      vi.useFakeTimers();
      const child = new FakeClaudePrintChild();
      child.exitOnKill = false;
      const notifications: ControllerNotification[] = [];
      const controller = createController(child, notifications);
      try {
        await ensureController(controller, child);
        await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
        await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
        child.emitStdout(firstResult);
        if (phase === 'active')
          child.emitStdout({ type: 'system', subtype: 'init', session_id: TEST_SESSION_ID, model: 'haiku' });
        await expect(controller.turnInterrupt({ brokerTurnId: 'turn-1' })).resolves.toEqual({
          brokerTurnId: 'turn-1',
          interrupted: true,
        });
        child.emitStdout(replay(firstSendId));
        child.emitStdout(finalResult);
        await expect(
          controller.turnSend({ brokerTurnId: 'turn-1', text: 'stopping', clientMessageId: secondSendId }),
        ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
        await vi.advanceTimersByTimeAsync(32_500);
        expect(notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);
        expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await vi.advanceTimersByTimeAsync(0);
        expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
        expect(notifications.at(-1)?.params).toMatchObject({
          cancelled: true,
          brokerTurnId: 'turn-1',
          result: `DONE${separator}FOLLOW_ON`,
          durationMs: 1200,
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await controller.shutdown();
        vi.useRealTimers();
      }
    },
  );

  it('retains completed segment evidence and unread IDs on an unexpected child exit, failing once', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
      child.emitStdout(firstResult);
      child.emitExit({ code: 1, signal: null });
      child.emitExit({ code: 1, signal: null });
      const failures = notifications.filter((n) => n.method === 'turn/failed');
      expect(failures).toHaveLength(1);
      expect(failures[0].params).toMatchObject({
        result: 'DONE',
        durationMs: 500,
        usage: firstResult.usage,
        diagnostic: { reason: 'child-exit' },
      });
      expect(notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);
      expect(notifications.filter((n) => n.method === 'turn/progress').map((n) => n.params.message)).toContain(
        `Sent message ${firstSendId} was not read before the child exited`,
      );
    } finally {
      await controller.shutdown();
    }
  });

  it.each([false, true])(
    'carries joined text, final failure=%s, usage, turns progress and duration through pool and kernel',
    async (fails) => {
      const child = new FakeClaudePrintChild();
      const h = await startKernelThroughPool(child);
      try {
        await h.send(firstSendId);
        child.emitStdout(firstResult);
        await expect(h.send(secondSendId)).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
        expect(h.onProviderTurnTerminal).not.toHaveBeenCalled();
        expect(h.spawnChild).toHaveBeenCalledTimes(1);
        child.emitStdout(replay(firstSendId));
        child.emitStdout({ ...finalResult, is_error: fails, errors: fails ? ['final segment failed'] : [] });
        const events = await h.events;
        const terminal = events.find((event) => event.kind === 'terminal');
        expect(terminal).toMatchObject({
          terminal: {
            content: `DONE${separator}FOLLOW_ON`,
            durationMs: 1200,
            outcome: { kind: fails ? 'failed' : 'completed' },
            usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03 },
          },
        });
        if (fails)
          expect(terminal?.failureCause).toMatchObject({
            body: { message: expect.stringContaining('final segment failed') },
          });
        const summaryIndex = events.findIndex(
          (event) => event.kind === 'progress' && event.message === 'Claude aggregate: 2 result segments; turns=5',
        );
        expect(summaryIndex).toBeGreaterThanOrEqual(0);
        expect(events.indexOf(terminal!)).toBeGreaterThan(summaryIndex);
        expect(terminal?.terminal.usage).not.toHaveProperty('numTurns');
        expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
      } finally {
        await h.broker.shutdown();
      }
    },
  );

  it.each(['expiry', 'cancelled'] as const)(
    'ends %s through pool and kernel only on accepted hold, fencing replacement until child absence',
    async (reason) => {
      vi.useFakeTimers();
      const child = new FakeClaudePrintChild();
      child.exitOnKill = false;
      const h = await startKernelThroughPool(child);
      const brokerSessionKey = String(h.continuity.brokerSessionKey);
      let finished = false;
      void h.events.then(() => {
        finished = true;
      });
      try {
        await h.send(firstSendId);
        child.emitStdout(firstResult);
        await vi.advanceTimersByTimeAsync(0);
        if (reason === 'cancelled') {
          h.abort.abort();
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(child.killedSignals).toEqual(['SIGTERM']);
        expect(finished).toBe(false);
        expect(h.onProviderTurnTerminal).not.toHaveBeenCalled();
        child.emitStdout({ type: 'keep_alive' });
        await vi.advanceTimersByTimeAsync(2_500);
        const events = await h.events;
        expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(h.onProviderTurnTerminal).toHaveBeenCalledExactlyOnceWith({
          kind: 'provider-turn-terminal',
          providerTurnId: 'turn-1',
          status: 'completed',
        });
        expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
        expect(events.find((event) => event.kind === 'terminal')).toMatchObject({
          terminal: {
            content: 'DONE',
            durationMs: 500,
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
            outcome: reason === 'cancelled' ? { kind: 'aborted', reason: 'signal_abort' } : { kind: 'completed' },
          },
        });
        expect(
          events.some(
            (event) =>
              event.kind === 'progress' && event.message.includes(firstSendId) && event.message.includes('not read'),
          ),
        ).toBe(true);
        const ensure = h.broker.sessionEnsure({
          brokerSessionKey,
          conversationRef: TEST_SESSION_ID,
          cwd: '/workspace',
          projectsRoot: '/tmp/projects',
          systemPromptHash: 'sha256:test',
          bootstrapConfigHash: 'sha256:test',
          permissionMode: 'default',
        });
        const rejected = expect(ensure).rejects.toMatchObject({
          message: expect.stringContaining('replacement is held'),
          data: expect.objectContaining({
            successor: { kind: 'accepted', owner: 'broker-session-pool' },
            operatorExit: { kind: 'retry-session-ensure' },
          }),
        });
        await vi.advanceTimersByTimeAsync(2_500);
        await rejected;
        expect(h.spawnChild).toHaveBeenCalledTimes(1);
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await vi.advanceTimersByTimeAsync(0);
        await expect(h.broker.shutdown()).resolves.toMatchObject({ kind: 'observed-absent' });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await h.broker.shutdown();
        vi.useRealTimers();
      }
    },
  );

  it('uses the existing interrupt path without killing when all sent messages have been consumed', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      await controller.turnSend({ brokerTurnId: 'turn-1', text: 'absorbed', clientMessageId: firstSendId });
      child.emitStdout(replay(firstSendId));
      const interrupt = controller.turnInterrupt({ brokerTurnId: 'turn-1' });
      await waitForWrite(child, 3);
      const request = parseWrite(child, 3);
      expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
      child.emitStdout({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.request_id, response: {} },
      });
      await interrupt;
      expect(child.killedSignals).toEqual([]);
      expect(controller.hasActiveTurn()).toBe(true);
      child.emitStdout(firstResult);
      expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
      expect(child.killedSignals).toEqual([]);
    } finally {
      await controller.shutdown();
    }
  });

  it('does not arm a follow-on deadline once real assistant activity starts', async () => {
    vi.useFakeTimers();
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
      child.emitStdout(firstResult);
      child.emitStdout({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'working' }] } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.hasActiveTurn()).toBe(true);
      expect(child.killedSignals).toEqual([]);
      child.emitStdout(replay(firstSendId));
      child.emitStdout(finalResult);
      expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await controller.shutdown();
      vi.useRealTimers();
    }
  });

  it('keeps completed text and usage through the kernel child-loss failure path', async () => {
    const child = new FakeClaudePrintChild();
    const h = await startKernelThroughPool(child);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await h.send(firstSendId);
      child.emitStdout(firstResult);
      child.emitExit({ code: 1, signal: null });
      const events = await h.events;
      expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
      expect(events.find((event) => event.kind === 'terminal')).toMatchObject({
        terminal: {
          content: 'DONE',
          durationMs: 500,
          outcome: { kind: 'failed' },
          usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
        },
        failureCause: { body: { diagnostic: { reason: 'child-exit' } } },
      });
      expect(
        events.some(
          (event) =>
            event.kind === 'progress' && event.message.includes(firstSendId) && event.message.includes('not read'),
        ),
      ).toBe(true);
      expect(h.onProviderTurnTerminal).toHaveBeenCalledExactlyOnceWith({
        kind: 'provider-turn-terminal',
        providerTurnId: 'turn-1',
        status: 'failed',
      });
    } finally {
      await h.broker.shutdown();
    }
  });

  it('retains a result without an observed start frame and keeps gap sends refused', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
      child.emitStdout(firstResult);
      child.emitStdout(finalResult);
      expect(notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);
      await expect(
        controller.turnSend({ brokerTurnId: 'turn-1', text: 'gap', clientMessageId: secondSendId }),
      ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
      child.emitStdout(replay(firstSendId));
      child.emitStdout({ ...finalResult, result: 'THIRD', total_cost_usd: 0.05 });
      expect(notifications.at(-1)?.params).toMatchObject({
        result: `DONE${separator}FOLLOW_ON${separator}THIRD`,
        numTurns: 8,
        durationMs: 1900,
        costUsd: 0.05,
      });
    } finally {
      await controller.shutdown();
    }
  });

  it.each(['throws', 'wrong-owner'] as const)(
    'keeps cleanup owned when shutdown transfer %s instead of acknowledging pool ownership',
    async (reply) => {
      vi.useFakeTimers();
      const child = new FakeClaudePrintChild();
      child.exitOnKill = false;
      const notifications: ControllerNotification[] = [];
      const onShutdownHeld = vi.fn(() => {
        if (reply === 'throws') throw new Error('pool refused the transfer');
        return { kind: 'accepted', owner: 'other-owner' } as never;
      });
      const controller = createController(child, notifications, { onShutdownHeld });
      try {
        await ensureController(controller, child);
        await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
        await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
        child.emitStdout(firstResult);
        await vi.advanceTimersByTimeAsync(32_500);
        expect(onShutdownHeld).toHaveBeenCalledOnce();
        child.emitStdout({ ...finalResult, is_error: true, errors: ['late failure'] });
        expect(notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);
        expect(controller.hasActiveTurn()).toBe(true);
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await vi.advanceTimersByTimeAsync(0);
        expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
        expect(notifications.at(-1)?.params).toMatchObject({
          result: `DONE${separator}FOLLOW_ON`,
          isError: true,
          errors: ['late failure'],
          durationMs: 1200,
        });
      } finally {
        child.emitExit({ code: null, signal: 'SIGKILL' });
        await controller.shutdown();
        vi.useRealTimers();
      }
    },
  );

  it('keeps zero-valued token, cumulative cost, turn and duration totals available', async () => {
    const child = new FakeClaudePrintChild();
    const notifications: ControllerNotification[] = [];
    const controller = createController(child, notifications);
    const zeroResult = {
      ...firstResult,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      num_turns: 0,
      duration_ms: 0,
      total_cost_usd: 0,
    };
    try {
      await ensureController(controller, child);
      await controller.turnStart({ brokerTurnId: 'turn-1', prompt: 'hello' });
      await controller.turnSend({ brokerTurnId: 'turn-1', text: 'late', clientMessageId: firstSendId });
      child.emitStdout(zeroResult);
      child.emitStdout(replay(firstSendId));
      child.emitStdout(zeroResult);
      expect(notifications.at(-1)?.params).toMatchObject({
        usage: zeroResult.usage,
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
      });
      expect(notifications.at(-2)?.params).toMatchObject({ message: 'Claude aggregate: 2 result segments; turns=0' });
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
        'Claude aggregate: 1 result segments; turns=2',
      ]);
      expect(notifications.filter((n) => n.method === 'turn/completed')).toHaveLength(1);
    } finally {
      await controller.shutdown();
    }
  });

  it('refuses the checkpoint-to-start window, then carries an absorbed send through the facet, pool and kernel', async () => {
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
        if (method === 'turn/start') {
          expect(continuity).toMatchObject({ brokerTurnId: 'turn-1' });
          expect(steering.admit(continuity, firstSendId)).toMatchObject({
            state: 'refused',
            code: 'turn_not_started',
          });
          await expect(
            broker.turnSend({
              brokerSessionKey: String(continuity.brokerSessionKey),
              brokerTurnId: 'turn-1',
              text: 'too early',
              clientMessageId: secondSendId,
            }),
          ).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
          expect(child.writes).toHaveLength(1);
          return broker.turnStart(params as unknown as Parameters<typeof broker.turnStart>[0]);
        }
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

  it('refuses a pool-level gap send and accepts the observed follow-on under the same kernel turn id', async () => {
    const child = new FakeClaudePrintChild();
    const h = await startKernelThroughPool(child);
    const activeContinuity = { ...h.continuity };
    try {
      expect(h.steering.admit(activeContinuity, firstSendId)).toEqual({ state: 'admitted' });
      await expect(h.send(firstSendId)).resolves.toEqual({ state: 'delivered' });
      child.emitStdout(firstResult);
      await expect(h.send(secondSendId)).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
      expect(child.writes).toHaveLength(3);
      expect(h.onProviderTurnTerminal).not.toHaveBeenCalled();
      expect(h.continuity).toEqual(activeContinuity);

      child.emitStdout({ type: 'system', subtype: 'init', session_id: TEST_SESSION_ID, model: 'haiku' });
      expect(h.steering.admit(activeContinuity, secondSendId)).toEqual({ state: 'admitted' });
      await expect(h.send(secondSendId)).resolves.toEqual({ state: 'delivered' });
      child.emitStdout(replay(firstSendId));
      child.emitStdout(replay(secondSendId));
      child.emitStdout(finalResult);

      const events = await h.events;
      expect(h.onProviderTurnTerminal).toHaveBeenCalledExactlyOnceWith({
        kind: 'provider-turn-terminal',
        providerTurnId: 'turn-1',
        status: 'completed',
      });
      expect(events.filter((event) => event.kind === 'terminal')).toHaveLength(1);
      expect(h.steering.admit(activeContinuity, secondSendId)).toMatchObject({
        state: 'refused',
        code: 'turn_ended',
      });
      await expect(h.send(secondSendId)).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
      expect(child.writes).toHaveLength(4);
      expect(h.spawnChild).toHaveBeenCalledOnce();
    } finally {
      await h.broker.shutdown();
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
