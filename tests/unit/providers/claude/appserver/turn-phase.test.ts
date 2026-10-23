import type * as MockedNodeFsModule from 'node:fs';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const controllers: SingleSessionController[] = [];
let fixtureIndex = 0;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.shutdown();
  vi.useRealTimers();
});

function transcriptFixture() {
  const projectsRoot = '/transcripts/phase-' + fixtureIndex++;
  const pathFor = (ref: string, project = 'workspace') => join(projectsRoot, project, ref + '.jsonl');
  mkdirSync(join(projectsRoot, 'workspace'), { recursive: true });
  writeFileSync(pathFor(TEST_SESSION_ID), '');
  return { projectsRoot, pathFor, path: pathFor(TEST_SESSION_ID) };
}

function userRow(text: string, sessionId = TEST_SESSION_ID) {
  return { type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function queueRow(content: string) {
  return { type: 'queue-operation', operation: 'enqueue', sessionId: TEST_SESSION_ID, content };
}

function assistantRow(stopReason?: string, sessionId = TEST_SESSION_ID) {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-test',
      content: [{ type: 'text', text: 'response' }],
      ...(stopReason ? { stop_reason: stopReason } : {}),
    },
  };
}

async function appendRows(path: string, ...rows: unknown[]) {
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await vi.advanceTimersByTimeAsync(100);
}

async function startController(prompt = 'hello', fixture = transcriptFixture()) {
  const child = new FakeClaudeChild();
  const notifications: ControllerNotification[] = [];
  const controller = new SingleSessionController({
    spawnChild: () => child,
    ids: { uuid: () => TEST_SESSION_ID },
    monotonicNow: () => BigInt(Date.now()),
    readySettleMs: 1,
    promptAckTimeoutMs: 60_000,
  });
  controllers.push(controller);
  controller.subscribeNotifications((notification) => notifications.push(notification));
  const ensure = controller.sessionEnsure({
    cwd: '/workspace',
    projectsRoot: fixture.projectsRoot,
    systemPromptHash: 'sha256:test',
    bootstrapConfigHash: 'sha256:test-bootstrap',
    permissionMode: 'default',
  });
  await vi.advanceTimersByTimeAsync(10);
  await ensure;
  await controller.turnStart({ brokerTurnId: 'turn-1', prompt });
  return { ...fixture, controller, child, notifications };
}

function observedPhase(harness: Awaited<ReturnType<typeof startController>>) {
  harness.child.emitExit({ code: 1, signal: null });
  const failed = harness.notifications.find((notification) => notification.method === 'turn/failed');
  return failed?.method === 'turn/failed' ? failed.params.diagnostic?.phase : undefined;
}

describe('Claude turn phase state machine', () => {
  it.each([false, true])('waits for its user row before accepting a dangling answer (queued=%s)', async (queued) => {
    const prompt = 'Skip the sleep. What command did I ask you to run?';
    const harness = await startController(prompt);
    if (queued) await appendRows(harness.path, queueRow(prompt));
    await appendRows(
      harness.path,
      { ...userRow(prompt), isSidechain: true },
      {
        type: 'user',
        session_id: TEST_SESSION_ID,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sleep', content: 'Exit code 137' }] },
      },
      {
        ...assistantRow('end_turn'),
        message: {
          ...assistantRow().message,
          content: [{ type: 'text', text: 'No response requested.' }],
          stop_reason: 'end_turn',
          usage: { output_tokens: 99 },
        },
      },
      { type: 'system', subtype: 'turn_duration', session_id: TEST_SESSION_ID, durationMs: 999 },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.controller.hasActiveTurn()).toBe(true);
    expect(harness.notifications.filter((n) => n.method === 'turn/completed')).toEqual([]);

    await appendRows(harness.path, userRow(prompt), assistantRow('end_turn'));
    await vi.advanceTimersByTimeAsync(2_000);
    const completed = harness.notifications.filter((n) => n.method === 'turn/completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].params).toMatchObject({ brokerTurnId: 'turn-1', result: 'response' });
    expect(completed[0].params).not.toMatchObject({ durationMs: 999 });
    expect(
      harness.notifications.some(
        (n) => n.method === 'turn/progress' && n.params.message.includes('No response requested.'),
      ),
    ).toBe(false);
  });

  it('advances responding to ending on an end-turn assistant row', async () => {
    const harness = await startController();
    await appendRows(harness.path, userRow('hello'), assistantRow('end_turn'));
    expect(observedPhase(harness)).toBe('ending');
  });

  it('does not keep reading a cached transcript after the session id changes', async () => {
    const nextSessionId = '00000000-0000-4000-8000-000000000002';
    const fixture = transcriptFixture();
    writeFileSync(fixture.pathFor(nextSessionId), '');
    const harness = await startController('hello', fixture);
    await appendRows(harness.path, {
      type: 'system',
      subtype: 'turn_duration',
      session_id: nextSessionId,
      durationMs: 25,
    });
    await appendRows(
      fixture.pathFor(nextSessionId),
      userRow('hello', nextSessionId),
      assistantRow(undefined, nextSessionId),
    );
    expect(observedPhase(harness)).toBe('responding');
  });

  it('does not arbitrarily select a transcript when the conversation ref is ambiguous across projects', async () => {
    const fixture = transcriptFixture();
    mkdirSync(join(fixture.projectsRoot, 'other'), { recursive: true });
    writeFileSync(fixture.pathFor(TEST_SESSION_ID, 'other'), '');
    const harness = await startController('hello', fixture);
    await appendRows(harness.path, userRow('hello'));
    await appendRows(fixture.pathFor(TEST_SESSION_ID, 'other'), userRow('hello'));
    expect(observedPhase(harness)).toBe('sent');
  });

  it('does not register mismatched user rows', async () => {
    const fixture = transcriptFixture();
    writeFileSync(fixture.path, JSON.stringify(userRow('hello')) + '\n' + JSON.stringify(queueRow('hello')) + '\n');
    const harness = await startController('hello', fixture);
    await appendRows(
      harness.path,
      userRow('different prompt'),
      userRow('hello', 'other-session'),
      queueRow('different prompt'),
      {
        type: 'user',
        session_id: TEST_SESSION_ID,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }] },
      },
    );
    expect(observedPhase(harness)).toBe('sent');
  });
});
