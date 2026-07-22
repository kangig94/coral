import { describe, expect, it } from 'vitest';

import {
  compose,
  type Provider,
  type ProviderEventBody,
  type ProviderRequest,
  type ProviderRuntime,
} from '#src/providers/contract.js';
import { TEST_CODEX_PLAN } from '../../helpers/provider-credentials.js';

type TestProviderContext = typeof TEST_CODEX_PLAN;
type TestProvider = Provider<TestProviderContext>;
type TestRuntime = ProviderRuntime<TestProviderContext>;

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'compose-terminal-once',
  prompt: 'hello',
  cwd: process.cwd(),
  bypassPermissions: false,
  coralEnv: {},
};

const BASE_RUNTIME: TestRuntime = {
  signal: new AbortController().signal,
  runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
  time: {
    now: () => 0,
    setTimeout: () => ({ unref: () => {} }),
    clearTimeout: () => {},
  } as TestRuntime['time'],
  ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
  acquirePreparedServer: async () => {
    throw new Error('not used in compose tests');
  },
  storage: { existsSync: () => true } as unknown as TestRuntime['storage'],
  continuityBridge: {
    checkpoint: () => {},
    transportClosed: () => {},
  },
  kbRoot: '/mock/kb',
  executionPlan: TEST_CODEX_PLAN,
};

const COMPLETED_TERMINAL: ProviderEventBody = {
  kind: 'terminal',
  terminal: {
    content: 'done',
    durationMs: 0,
    outcome: { kind: 'completed' },
  },
  diagnostics: {},
};

const PROGRESS: ProviderEventBody = { kind: 'progress', message: 'tick' };
const CONTINUITY: ProviderEventBody = {
  kind: 'continuity',
  conversationRef: 'conversation-1',
  resumable: true,
  providerContinuity: {},
};

const WRAPPER_LOST_TERMINAL: ProviderEventBody = {
  kind: 'terminal',
  terminal: {
    content: '',
    durationMs: 0,
    outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
  },
  diagnostics: {},
};

function fromEvents(events: readonly ProviderEventBody[]): TestProvider {
  return async function* eventsProvider() {
    for (const event of events) {
      yield event;
    }
  };
}

describe('compose() terminalOnce guard', () => {
  it('passes progress, continuity, and terminal through unchanged on the happy path', async () => {
    const stream = compose([], fromEvents([PROGRESS, CONTINUITY, COMPLETED_TERMINAL]))(BASE_REQUEST, BASE_RUNTIME);

    const collected: ProviderEventBody[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([PROGRESS, CONTINUITY, COMPLETED_TERMINAL]);
  });

  it('synthesizes a wrapper_lost terminal when the inner stream closes without one', async () => {
    const stream = compose([], fromEvents([PROGRESS]))(BASE_REQUEST, BASE_RUNTIME);

    const collected: ProviderEventBody[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([PROGRESS, WRAPPER_LOST_TERMINAL]);
  });

  it('drops a second terminal yielded by a misbehaving inner stream', async () => {
    const second: ProviderEventBody = {
      kind: 'terminal',
      terminal: { content: 'second', durationMs: 0, outcome: { kind: 'failed' } },
      diagnostics: {},
      failureCause: {
        type: 'session.provider_failed',
        body: { provider: 'claude', reason: 'request_failed', message: 'noise' },
      },
    };
    const stream = compose([], fromEvents([COMPLETED_TERMINAL, second]))(BASE_REQUEST, BASE_RUNTIME);

    const collected: ProviderEventBody[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([COMPLETED_TERMINAL]);
  });

  it('drops post-terminal progress and continuity yields', async () => {
    const stream = compose([], fromEvents([COMPLETED_TERMINAL, PROGRESS, CONTINUITY]))(BASE_REQUEST, BASE_RUNTIME);

    const collected: ProviderEventBody[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([COMPLETED_TERMINAL]);
  });

  it('does not synthesize wrapper_lost when the consumer returns early', async () => {
    let yieldedAfterReturn = false;
    const provider: TestProvider = async function* slowProvider() {
      yield PROGRESS;
      // Inner provider continues — but consumer will .return() before this runs.
      yield PROGRESS;
      yieldedAfterReturn = true;
    };

    const iterator = compose([], provider)(BASE_REQUEST, BASE_RUNTIME)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toEqual({ value: PROGRESS, done: false });

    const returned = await iterator.return!();
    expect(returned.done).toBe(true);
    // No terminal value should be yielded by .return() — consumer opted out.
    expect(returned.value).toBeUndefined();
    expect(yieldedAfterReturn).toBe(false);
  });

  it('does not synthesize wrapper_lost when the inner stream throws', async () => {
    const failure = new Error('inner blew up');
    const provider: TestProvider = async function* throwingProvider() {
      yield PROGRESS;
      throw failure;
    };

    const collected: ProviderEventBody[] = [];
    let caught: unknown;
    try {
      for await (const event of compose([], provider)(BASE_REQUEST, BASE_RUNTIME)) {
        collected.push(event);
      }
    } catch (err) {
      caught = err;
    }

    expect(collected).toEqual([PROGRESS]);
    expect(caught).toBe(failure);
  });
});
