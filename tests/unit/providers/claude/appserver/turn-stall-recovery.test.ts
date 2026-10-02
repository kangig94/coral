import type * as MockedNodeFsModule from 'node:fs';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrokerSessionPool } from '#src/providers/claude/appserver/broker-pool.js';
import { SingleSessionController } from '#src/providers/claude/appserver/controller.js';
import type {
  ControllerNotification,
  SpawnClaudeChildOptions,
} from '#src/providers/claude/appserver/session-contract.js';
import { DEFAULT_TURN_RECOVERY_BUDGET } from '#src/providers/claude/appserver/turn-recovery-budget.js';
import { FakeClaudeChild } from '#tests/helpers/fake-claude-child.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

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

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000101';
const TEST_MODEL = 'claude-sonnet-test';
const controllers: SingleSessionController[] = [];
const pools: BrokerSessionPool[] = [];
let fixtureIndex = 0;

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.shutdown();
  for (const pool of pools.splice(0)) await pool.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function transcriptFixture() {
  const projectsRoot = '/transcripts/stall-' + fixtureIndex++;
  const project = join(projectsRoot, 'workspace');
  mkdirSync(project, { recursive: true });
  const path = join(project, TEST_SESSION_ID + '.jsonl');
  writeFileSync(path, '');
  return { projectsRoot, path };
}

function ensureParams(projectsRoot: string) {
  return {
    cwd: '/workspace',
    projectsRoot,
    systemPromptHash: 'sha256:test',
    bootstrapConfigHash: 'sha256:test-bootstrap',
    permissionMode: 'default' as const,
  };
}

function promptRow(prompt: string) {
  return {
    type: 'user',
    session_id: TEST_SESSION_ID,
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  };
}

function assistantRow(text: string, stopReason?: string, sessionId = TEST_SESSION_ID) {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      model: TEST_MODEL,
      content: [{ type: 'text', text }],
      ...(stopReason ? { stop_reason: stopReason } : {}),
    },
  };
}

function durationRow(durationMs: number) {
  return { type: 'system', subtype: 'turn_duration', session_id: TEST_SESSION_ID, durationMs };
}

async function appendRows(path: string, ...rows: unknown[]) {
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await vi.advanceTimersByTimeAsync(100);
}

async function startController(prompt: string) {
  const fixture = transcriptFixture();
  const children: FakeClaudeChild[] = [];
  const spawnOptions: SpawnClaudeChildOptions[] = [];
  const notifications: ControllerNotification[] = [];
  const controller = new SingleSessionController({
    spawnChild: (options) => {
      spawnOptions.push(options);
      const child = new FakeClaudeChild();
      children.push(child);
      return child;
    },
    ids: { uuid: () => TEST_SESSION_ID },
    monotonicNow: () => BigInt(Date.now()),
    readySettleMs: 1,
  });
  controllers.push(controller);
  controller.subscribeNotifications((notification) => notifications.push(notification));
  const ensure = controller.sessionEnsure(ensureParams(fixture.projectsRoot));
  await vi.advanceTimersByTimeAsync(10);
  await ensure;
  await controller.turnStart({ brokerTurnId: 'turn-1', prompt });
  return { ...fixture, controller, children, spawnOptions, notifications };
}

function pastedPrompts(child: FakeClaudeChild) {
  return child.writes.filter((write) => write.startsWith('\x1b[200~')).map((write) => write.slice(6, -7));
}

async function startPool(subscribe = true) {
  const fixture = transcriptFixture();
  const children: FakeClaudeChild[] = [];
  const notifications: unknown[] = [];
  const ids = ['broker-1', TEST_SESSION_ID];
  const pool = new BrokerSessionPool({
    spawnChild: () => {
      const child = new FakeClaudeChild();
      children.push(child);
      return child;
    },
    ids: { uuid: () => ids.shift() ?? TEST_SESSION_ID },
    monotonicNow: () => BigInt(Date.now()),
  });
  pools.push(pool);
  if (subscribe) pool.subscribeNotifications((notification) => notifications.push(notification));
  const ensure = pool.sessionEnsure(ensureParams(fixture.projectsRoot));
  await vi.advanceTimersByTimeAsync(1_000);
  const ensured = await ensure;
  await pool.turnStart({ brokerSessionKey: ensured.brokerSessionKey, brokerTurnId: 'turn-1', prompt: 'pool prompt' });
  return { ...fixture, pool, children, notifications, brokerSessionKey: ensured.brokerSessionKey };
}

describe('Claude phase-specific turn-stall recovery', () => {
  it('resends the original prompt only while the turn is still sent', async () => {
    const harness = await startController('original sent prompt');
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_RECOVERY_BUDGET.registration.promptAckMs);
    expect(harness.children).toHaveLength(1);
    expect(pastedPrompts(harness.children[0])).toEqual(['original sent prompt', 'original sent prompt']);
  });

  it('treats Claude queue-operation enqueue as registration so sent recovery does not duplicate queued prompts', async () => {
    const prompt = 'queued prompt must not duplicate';
    const harness = await startController(prompt);
    await appendRows(harness.path, {
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: TEST_SESSION_ID,
      content: prompt,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_RECOVERY_BUDGET.registration.promptAckMs);
    expect(harness.children).toHaveLength(1);
    expect(pastedPrompts(harness.children[0])).toEqual([prompt]);
    expect(harness.controller.hasActiveTurn()).toBe(true);
  });

  it('recovers a registered stall by respawning with resume and continuing the unanswered message', async () => {
    const prompt = 'registered prompt must not duplicate';
    const harness = await startController(prompt);
    await appendRows(harness.path, promptRow(prompt));
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_RECOVERY_BUDGET['assistant-start'].assistantStartIdleMs + 100);
    expect(harness.spawnOptions).toHaveLength(2);
    expect(harness.spawnOptions[1]).toMatchObject({ conversationRef: TEST_SESSION_ID, resume: true });
    expect(harness.children[0].killSignals).toEqual(['SIGTERM']);
    expect(pastedPrompts(harness.children[0])).toEqual([prompt]);
    const continuation = pastedPrompts(harness.children[1])[0];
    expect(continuation).toContain('unanswered user message');
    expect(continuation).not.toContain(prompt);
    await appendRows(harness.path, assistantRow('recovered answer', 'end_turn'), durationRow(25));
    expect(harness.notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({ brokerTurnId: 'turn-1', result: 'recovered answer' }),
      }),
    );
  });

  it('recovers a responding stall with a partial-response continuation and never re-pastes the original prompt', async () => {
    const prompt = 'ORIGINAL_PROMPT_SHOULD_NOT_REAPPEAR';
    const harness = await startController(prompt);
    await appendRows(harness.path, promptRow(prompt), assistantRow('partial answer'));
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_RECOVERY_BUDGET['assistant-progress'].assistantProgressIdleMs + 100);
    expect(harness.spawnOptions).toHaveLength(2);
    expect(harness.spawnOptions[1]).toMatchObject({ conversationRef: TEST_SESSION_ID, resume: true });
    expect(pastedPrompts(harness.children[0])).toEqual([prompt]);
    const continuation = pastedPrompts(harness.children[1])[0];
    expect(continuation).toContain('partial assistant response');
    expect(continuation).not.toContain(prompt);
  });

  it('completes an ending turn from parsed transcript fields after the finalization grace', async () => {
    const harness = await startController('ending prompt');
    await appendRows(harness.path, promptRow('ending prompt'), assistantRow('parsed final answer', 'end_turn'));
    expect(harness.controller.hasActiveTurn()).toBe(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_RECOVERY_BUDGET['finalization-grace'].finalizationGraceMs);
    expect(harness.controller.hasActiveTurn()).toBe(false);
    expect(harness.notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({ brokerTurnId: 'turn-1', result: 'parsed final answer' }),
      }),
    );
  });

  it('does not let a late assistant row after end_turn overwrite the completed result', async () => {
    const harness = await startController('ending prompt');
    await appendRows(harness.path, promptRow('ending prompt'), assistantRow('parsed final answer', 'end_turn'));
    await appendRows(
      harness.path,
      { ...assistantRow('late same-session overwrite'), error: 'late error' },
      assistantRow('foreign overwrite', undefined, '00000000-0000-4000-8000-000000000202'),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_RECOVERY_BUDGET['finalization-grace'].finalizationGraceMs);
    expect(harness.notifications).toContainEqual(
      expect.objectContaining({
        method: 'turn/completed',
        params: expect.objectContaining({ result: 'parsed final answer', isError: false }),
      }),
    );
  });

  it('defers replacement and preserves the turn while the old child remains unsettled past repeated recovery polls', async () => {
    const harness = await startPool();
    await appendRows(harness.path, promptRow('pool prompt'));
    harness.children[0].exitOnKill = false;
    await vi.advanceTimersByTimeAsync(
      DEFAULT_TURN_RECOVERY_BUDGET['assistant-start'].assistantStartIdleMs +
        DEFAULT_TURN_RECOVERY_BUDGET.replacement.replacementShutdownMs +
        1_000,
    );
    expect(harness.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.children).toHaveLength(1);
    await expect(harness.pool.sessionProbe({ brokerSessionKey: harness.brokerSessionKey })).resolves.toMatchObject({
      status: 'available',
      activeTurnId: 'turn-1',
    });
    harness.children[0].emitExit({ code: null, signal: 'SIGTERM' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.children).toHaveLength(2);
    expect(harness.children[1].disposed).toBe(false);
    await expect(harness.pool.sessionProbe({ brokerSessionKey: harness.brokerSessionKey })).resolves.toMatchObject({
      status: 'available',
      activeTurnId: 'turn-1',
    });
  });

  it('evicts a generated controller after a terminal turn queued during initial notification hold', async () => {
    const immediateCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
      immediateCallbacks.push(callback as () => void);
      return {} as ReturnType<typeof setImmediate>;
    });
    const harness = await startPool(false);
    await appendRows(
      harness.path,
      promptRow('pool prompt'),
      assistantRow('queued terminal result', 'end_turn'),
      durationRow(25),
    );
    await expect(harness.pool.sessionProbe({ brokerSessionKey: harness.brokerSessionKey })).resolves.toMatchObject({
      status: 'available',
      activeTurnId: null,
    });
    immediateCallbacks.shift()!();
    immediateCallbacks.shift()!();
    await flushMicrotasks();
    await expect(harness.pool.sessionProbe({ brokerSessionKey: harness.brokerSessionKey })).resolves.toMatchObject({
      status: 'missing',
    });
  });
});
