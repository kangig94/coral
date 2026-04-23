import { describe, expect, it, vi } from 'vitest';

import type { AppServerNotificationMessage, ProviderEventBody, ProviderRequest, ProviderRuntime } from '#src/providers/contract.js';
import {
  PRE_TURN_MAILBOX_CAP,
  applyCodexNotificationForTest,
  createCodexTurnStateForTest,
} from '#src/providers/codex/thread-kernel.js';

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

function makeRuntime(
  persistedContinuity: ProviderRuntime['persistedContinuity'] = {
    cwd: '/workspace/persisted',
    threadId: 'persisted-thread',
  },
): ProviderRuntime {
  return {
    signal: new AbortController().signal,
    runCli: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, aborted: false })),
    acquireServer: vi.fn(async () => {
      throw new Error('acquireServer should not be called in thread-kernel mailbox tests.');
    }),
    persistedContinuity,
    continuityBridge: {
      checkpoint: () => {},
      transportClosed: () => {},
    },
  };
}

function webSearchStarted(threadId: string, query: string): AppServerNotificationMessage {
  return {
    method: 'item/started',
    params: {
      threadId,
      item: {
        type: 'webSearch',
        query,
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
    expect(state.preTurnMailbox.status()).toEqual({ pending: 1, dropped: 0 });

    applyCodexNotificationForTest(state, webSearchStarted('persisted-thread', 'oldest-matching'), emit);
    applyCodexNotificationForTest(state, webSearchStarted('foreign-thread', 'foreign-before-thread'), emit);
    expect(state.preTurnMailbox.status()).toEqual({ pending: 2, dropped: 0 });

    state.threadId = 'persisted-thread';
    state.threadIds.add('persisted-thread');

    applyCodexNotificationForTest(state, webSearchStarted('foreign-thread', 'foreign-after-thread-known'), emit);
    expect(state.preTurnMailbox.status()).toEqual({ pending: 2, dropped: 0 });

    for (let index = 0; index < PRE_TURN_MAILBOX_CAP; index += 1) {
      applyCodexNotificationForTest(state, webSearchStarted('persisted-thread', `keep-${index}`), emit);
    }
    expect(state.preTurnMailbox.status()).toEqual({ pending: PRE_TURN_MAILBOX_CAP, dropped: 2 });

    state.turnStartRequested = true;
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

    expect(state.turnId).toBe('turn-1');
    expect(state.preTurnMailbox.status()).toEqual({ pending: 0, dropped: 3 });

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
});
