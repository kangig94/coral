import { describe, expect, it, vi } from 'vitest';

import type {
  AppServerSession,
  ProviderAppServerRuntime,
  ProviderEventBody,
  ProviderRequest,
} from '#src/providers/contract.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import type { AppServerNotificationMessage } from '#src/providers/protocol.js';
import type { DirentLike, EnvPort, StoragePort } from '#src/infra/port-types.js';
import {
  PRE_TURN_MAILBOX_CAP,
  applyCodexNotificationForTest,
  buildCodexAbortedTerminalForTest,
  buildCodexCompletedTerminalForTest,
  buildCodexFailedTerminalForTest,
  createCodexTurnStateForTest,
  finishCodexCompletedForTest,
} from '#src/providers/codex/thread-kernel.js';
import { TEST_CODEX_PLAN } from '../../../helpers/provider-credentials.js';

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'resume',
    sessionId: 'job-codex-thread-kernel',
    name: 'codex',
    conversationRef: 'request-thread',
    prompt: 'Resume and continue',
    cwd: '/workspace/request',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

type CodexRuntime = ProviderAppServerRuntime<CodexExecutionPlan>;

const APP_SERVER_SESSION: AppServerSession = {
  rpc: async <Result>() => ({}) as Result,
  subscribe: () => () => {},
  closed: new Promise<Error | void>(() => {}),
  interrupt: async () => false,
};

function makeRuntime(
  persistedContinuity: CodexRuntime['persistedContinuity'] = {
    cwd: '/workspace/persisted',
    threadId: 'persisted-thread',
  },
  overrides: Partial<Pick<CodexRuntime, 'env' | 'storage'>> = {},
): CodexRuntime {
  return {
    transport: 'app-server',
    signal: new AbortController().signal,
    time: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        if (handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
    ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
    appServerSession: APP_SERVER_SESSION,
    storage: overrides.storage ?? ({ existsSync: () => true } as unknown as CodexRuntime['storage']),
    ...(overrides.env ? { env: overrides.env } : {}),
    persistedContinuity,
    continuityBridge: {
      checkpoint: () => {},
      transportClosed: () => {},
    },
    kbRoot: '/mock/kb',
    executionPlan: TEST_CODEX_PLAN,
  };
}

function dirent(name: string, kind: 'file' | 'dir'): DirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function artifactStorage(tree: Record<string, DirentLike[]>, operations: string[] = []): CodexRuntime['storage'] {
  return {
    existsSync: (path) => {
      operations.push(`exists:${path}`);
      return Object.prototype.hasOwnProperty.call(tree, path);
    },
    readdirSync: ((path: string) => {
      operations.push(`readdir:${path}`);
      return tree[path] ?? [];
    }) as unknown as StoragePort['readdirSync'],
    readFileSync: () => '',
    statSync: (() => ({
      size: 0,
      mtimeMs: 0,
      isDirectory: () => false,
      isFile: () => true,
    })) as unknown as StoragePort['statSync'],
  };
}

function env(homedir = '/home/user'): Pick<EnvPort, 'homedir' | 'get' | 'fullSnapshot'> {
  return {
    homedir: () => homedir,
    get: () => undefined,
    fullSnapshot: () => ({}),
  };
}

function webSearchStarted(threadId: string, query: string): AppServerNotificationMessage {
  return {
    method: 'item/started',
    params: {
      threadId,
      turnId: 'turn-1',
      item: {
        type: 'webSearch',
        query,
      },
    },
  };
}

function prepareStartedTurn(state: ReturnType<typeof createCodexTurnStateForTest>): void {
  state.threadId = 'thread-usage';
  state.threadIds.add('thread-usage');
  state.activeAttempt.turnId = 'turn-usage';
  state.activeAttempt.startSettled = true;
  state.activeAttempt.lifecycle = 'active';
}

function tokenUsageEvent(
  total: Record<string, unknown>,
  last: Record<string, unknown> = {},
): AppServerNotificationMessage {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-usage',
      turnId: 'turn-usage',
      tokenUsage: {
        total,
        last,
      },
    },
  };
}

describe('codexTurnKernel pre-turn mailbox', () => {
  it('admits only lifecycle-compatible notifications, evicts FIFO over cap, and replays retained matches after turn discovery', () => {
    const state = createCodexTurnStateForTest(
      makeRequest({
        conversationRef: 'persisted-thread',
      }),
      makeRuntime({
        cwd: '/workspace/persisted',
        threadId: 'persisted-thread',
      }),
    );
    const events: ProviderEventBody[] = [];
    const emit = (event: ProviderEventBody) => {
      events.push(event);
    };

    applyCodexNotificationForTest(
      state,
      {
        method: 'thread/name/updated',
        params: {
          name: 'still lifecycle-scoped without thread id',
        },
      },
      emit,
    );
    expect(state.preTurnMailbox.status()).toEqual({ pending: 0, dropped: 0 });

    applyCodexNotificationForTest(state, webSearchStarted('persisted-thread', 'oldest-matching'), emit);
    applyCodexNotificationForTest(state, webSearchStarted('foreign-thread', 'foreign-before-thread'), emit);
    expect(state.preTurnMailbox.status()).toEqual({ pending: 1, dropped: 0 });

    state.threadId = 'persisted-thread';
    state.threadIds.add('persisted-thread');

    applyCodexNotificationForTest(state, webSearchStarted('foreign-thread', 'foreign-after-thread-known'), emit);
    expect(state.preTurnMailbox.status()).toEqual({ pending: 1, dropped: 0 });

    for (let index = 0; index < PRE_TURN_MAILBOX_CAP; index += 1) {
      applyCodexNotificationForTest(state, webSearchStarted('persisted-thread', `keep-${index}`), emit);
    }
    expect(state.preTurnMailbox.status()).toEqual({ pending: PRE_TURN_MAILBOX_CAP, dropped: 1 });

    state.activeAttempt.turnStartRequested = true;
    state.activeAttempt.startSettled = true;
    applyCodexNotificationForTest(
      state,
      {
        method: 'turn/started',
        params: {
          threadId: 'persisted-thread',
          turn: {
            id: 'turn-1',
          },
        },
      },
      emit,
    );

    expect(state.activeAttempt.turnId).toBe('turn-1');
    expect(state.preTurnMailbox.status()).toEqual({ pending: 0, dropped: 2 });

    const progressMessages = events.flatMap((event) => (event.kind === 'progress' ? [event.message] : []));

    expect(progressMessages).toContain('Searching: keep-1');
    expect(progressMessages).toContain(`Searching: keep-${PRE_TURN_MAILBOX_CAP - 1}`);
    expect(progressMessages).toContain('Turn started (turn-1).');
    expect(progressMessages).not.toContain('Searching: oldest-matching');
    expect(progressMessages).not.toContain('Searching: foreign-before-thread');
    expect(progressMessages).not.toContain('Searching: foreign-after-thread-known');
    expect(progressMessages).not.toContain('Searching: keep-0');
  });

  it('admits notifications for both request conversationRef and resumed thread id before turn discovery when thread/resume returns a different id', () => {
    const state = createCodexTurnStateForTest(
      makeRequest({
        conversationRef: 'request-thread',
      }),
      makeRuntime({
        cwd: '/workspace/persisted',
        threadId: 'persisted-thread',
      }),
    );
    const events: ProviderEventBody[] = [];
    const emit = (event: ProviderEventBody) => {
      events.push(event);
    };

    state.threadId = 'resumed-thread';

    applyCodexNotificationForTest(state, webSearchStarted('request-thread', 'request-ref-before-turn'), emit);
    expect(state.preTurnMailbox.status()).toEqual({ pending: 1, dropped: 0 });

    applyCodexNotificationForTest(state, webSearchStarted('resumed-thread', 'resumed-thread-before-turn'), emit);
    expect(state.preTurnMailbox.status()).toEqual({ pending: 2, dropped: 0 });

    applyCodexNotificationForTest(state, webSearchStarted('foreign-thread', 'foreign-before-turn'), emit);
    expect(state.preTurnMailbox.status()).toEqual({ pending: 2, dropped: 0 });

    expect(events).toEqual([]);
  });

  it('normalizes empty streamed continuity ids before tracking turn state', () => {
    const state = createCodexTurnStateForTest(
      makeRequest({
        conversationRef: 'thread-1',
      }),
      makeRuntime({
        cwd: '/workspace/persisted',
        threadId: 'thread-1',
      }),
    );
    state.threadId = 'thread-1';
    state.threadIds.add('thread-1');
    state.activeAttempt.turnId = 'turn-1';
    state.activeAttempt.startSettled = true;
    const events: ProviderEventBody[] = [];
    const emit = (event: ProviderEventBody) => {
      events.push(event);
    };

    applyCodexNotificationForTest(
      state,
      {
        method: 'thread/started',
        params: {
          thread: {
            id: '',
          },
        },
      },
      emit,
    );
    applyCodexNotificationForTest(
      state,
      {
        method: 'turn/started',
        params: {
          threadId: 'thread-1',
          turn: {
            id: '',
          },
        },
      },
      emit,
    );

    expect(state.threadIds.has('')).toBe(false);
    expect(state.activeAttempt.turnId).toBe('turn-1');
    expect(state.subagentTurnIds.has('thread-1')).toBe(false);

    const progressMessages = events.flatMap((event) => (event.kind === 'progress' ? [event.message] : []));
    expect(progressMessages).not.toContain('Turn started (unknown).');
  });

  it('updates routing when an owned subagent thread starts a later turn', () => {
    const state = createCodexTurnStateForTest(makeRequest({ conversationRef: 'thread-1' }), makeRuntime());
    state.threadId = 'thread-1';
    state.threadIds.add('thread-1');
    state.threadIds.add('subagent-thread');
    state.activeAttempt.turnId = 'turn-1';
    state.activeAttempt.startSettled = true;
    state.activeAttempt.subagentThreadIds.add('subagent-thread');

    applyCodexNotificationForTest(
      state,
      {
        method: 'turn/started',
        params: { threadId: 'subagent-thread', turn: { id: 'subagent-turn-1' } },
      },
      () => {},
    );
    applyCodexNotificationForTest(
      state,
      {
        method: 'turn/completed',
        params: { threadId: 'subagent-thread', turn: { id: 'subagent-turn-1', status: 'completed' } },
      },
      () => {},
    );
    applyCodexNotificationForTest(
      state,
      {
        method: 'turn/started',
        params: { threadId: 'subagent-thread', turn: { id: 'subagent-turn-2' } },
      },
      () => {},
    );

    expect(state.subagentTurnIds.get('subagent-thread')).toBe('subagent-turn-2');
    expect(state.activeAttempt.activeSubagentTurns.has('subagent-thread')).toBe(true);
  });

  it('emits the rollout artifact handle at the first turn-completed notification after storage discovery', async () => {
    const root = '/home/user/.codex/sessions';
    const day = `${root}/2026/05/04`;
    const operations: string[] = [];
    const runtime = makeRuntime(
      {
        cwd: '/workspace/persisted',
        threadId: 'thread-1',
      },
      {
        env: env(),
        storage: artifactStorage(
          {
            [root]: [dirent('2026', 'dir')],
            [`${root}/2026`]: [dirent('05', 'dir')],
            [`${root}/2026/05`]: [dirent('04', 'dir')],
            [day]: [dirent('rollout-2026-05-04T00-00-00-thread-1.jsonl', 'file')],
          },
          operations,
        ),
      },
    );
    const state = createCodexTurnStateForTest(makeRequest({ conversationRef: 'thread-1' }), runtime);
    state.threadId = 'thread-1';
    state.threadIds.add('thread-1');
    state.activeAttempt.turnId = 'turn-1';
    const events: ProviderEventBody[] = [];
    const emit = (event: ProviderEventBody) => {
      operations.push(`emit:${event.kind}`);
      events.push(event);
    };

    await finishCodexCompletedForTest(state, { id: 'turn-1', status: 'completed' }, emit);

    expect(events).toContainEqual({
      kind: 'artifact_handle',
      handle: `${day}/rollout-2026-05-04T00-00-00-thread-1.jsonl`,
      identity: { kind: 'codex-rollout', threadId: 'thread-1' },
    });
    expect(operations.indexOf(`exists:${root}`)).toBeGreaterThanOrEqual(0);
    expect(operations.indexOf(`exists:${root}`)).toBeLessThan(operations.indexOf('emit:artifact_handle'));
  });

  it('does not emit a rollout artifact handle when the JSONL is not on disk at turn completion', async () => {
    const root = '/home/user/.codex/sessions';
    const day = `${root}/2026/05/04`;
    const runtime = makeRuntime(
      {
        cwd: '/workspace/persisted',
        threadId: 'thread-not-flushed',
      },
      {
        env: env(),
        storage: artifactStorage({
          [root]: [dirent('2026', 'dir')],
          [`${root}/2026`]: [dirent('05', 'dir')],
          [`${root}/2026/05`]: [dirent('04', 'dir')],
          [day]: [],
        }),
      },
    );
    const state = createCodexTurnStateForTest(makeRequest({ conversationRef: 'thread-not-flushed' }), runtime);
    state.threadId = 'thread-not-flushed';
    state.threadIds.add('thread-not-flushed');
    state.activeAttempt.turnId = 'turn-1';
    const events: ProviderEventBody[] = [];
    const emit = (event: ProviderEventBody) => {
      events.push(event);
    };

    await finishCodexCompletedForTest(state, { id: 'turn-1', status: 'completed' }, emit);

    expect(events.filter((event) => event.kind === 'artifact_handle')).toEqual([]);
  });

  it('does not re-emit the fixed rollout artifact handle on later turn completions', async () => {
    const root = '/home/user/.codex/sessions';
    const day = `${root}/2026/05/04`;
    const operations: string[] = [];
    const runtime = makeRuntime(
      {
        cwd: '/workspace/persisted',
        threadId: 'thread-1',
      },
      {
        env: env(),
        storage: artifactStorage(
          {
            [root]: [dirent('2026', 'dir')],
            [`${root}/2026`]: [dirent('05', 'dir')],
            [`${root}/2026/05`]: [dirent('04', 'dir')],
            [day]: [dirent('rollout-2026-05-04T00-00-00-thread-1.jsonl', 'file')],
          },
          operations,
        ),
      },
    );
    const state = createCodexTurnStateForTest(makeRequest({ conversationRef: 'thread-1' }), runtime);
    state.threadId = 'thread-1';
    state.threadIds.add('thread-1');
    state.activeAttempt.turnId = 'turn-1';
    state.activeAttempt.startSettled = true;
    const checkpoint = vi.fn();
    state.continuityBridge = { checkpoint, transportClosed: vi.fn() };
    const events: ProviderEventBody[] = [];
    const emit = (event: ProviderEventBody) => {
      events.push(event);
    };
    const completed = { id: 'turn-1', status: 'completed' };

    const firstTerminal = await finishCodexCompletedForTest(state, completed, emit);
    const repeatedTerminal = await finishCodexCompletedForTest(state, completed, emit);
    applyCodexNotificationForTest(
      state,
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', text: 'late answer', phase: 'final_answer' },
        },
      },
      emit,
    );
    applyCodexNotificationForTest(
      state,
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: { total: { inputTokens: 10, outputTokens: 2 } },
        },
      },
      emit,
    );

    expect(events.filter((event) => event.kind === 'artifact_handle')).toEqual([
      {
        kind: 'artifact_handle',
        handle: `${day}/rollout-2026-05-04T00-00-00-thread-1.jsonl`,
        identity: { kind: 'codex-rollout', threadId: 'thread-1' },
      },
    ]);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(firstTerminal?.kind).toBe('terminal');
    expect(repeatedTerminal).toBeNull();
    expect(state.lastAgentMessage).toBe('');
    expect(state.latestTokenCount).toBeNull();
    expect(operations.filter((operation) => operation === `exists:${root}`)).toHaveLength(1);
  });

  it('captures cumulative tokenUsage.total (not per-step last) from thread/tokenUsage/updated', () => {
    const state = createCodexTurnStateForTest(
      makeRequest({ conversationRef: 'thread-usage' }),
      makeRuntime({
        cwd: '/workspace/persisted',
        threadId: 'thread-usage',
      }),
    );
    prepareStartedTurn(state);
    const events: ProviderEventBody[] = [];
    const total = {
      totalTokens: 156_406,
      inputTokens: 155_699,
      cachedInputTokens: 142_720,
      outputTokens: 707,
      reasoningOutputTokens: 287,
    };

    applyCodexNotificationForTest(
      state,
      tokenUsageEvent(total, {
        totalTokens: 11,
        inputTokens: 10,
        cachedInputTokens: 9,
        outputTokens: 1,
      }),
      (event) => {
        events.push(event);
      },
    );

    expect(events).toEqual([]);
    expect(state.latestTokenCount).toEqual(total);
    expect(buildCodexCompletedTerminalForTest(state, { id: 'turn-usage', status: 'completed' }).terminal.usage).toEqual(
      {
        inputTokens: 12_979,
        cacheReadTokens: 142_720,
        outputTokens: 707,
      },
    );
  });

  it('passes the last captured usage through failed and aborted terminals', () => {
    const state = createCodexTurnStateForTest(
      makeRequest({ conversationRef: 'thread-usage' }),
      makeRuntime({
        cwd: '/workspace/persisted',
        threadId: 'thread-usage',
      }),
    );
    prepareStartedTurn(state);

    applyCodexNotificationForTest(
      state,
      tokenUsageEvent({
        totalTokens: 110,
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 10,
      }),
      () => {},
    );
    applyCodexNotificationForTest(
      state,
      tokenUsageEvent({
        totalTokens: 23,
        inputTokens: 20,
        cachedInputTokens: 8,
        outputTokens: 3,
      }),
      () => {},
    );

    const expectedUsage = {
      inputTokens: 12,
      cacheReadTokens: 8,
      outputTokens: 3,
    };
    expect(buildCodexFailedTerminalForTest(state, 'Codex failed after spending tokens.').terminal.usage).toEqual(
      expectedUsage,
    );
    expect(buildCodexAbortedTerminalForTest(state).terminal.usage).toEqual(expectedUsage);
  });
});
