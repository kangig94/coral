import { describe, expect, it } from 'vitest';

import {
  compose,
  type Provider,
  type ProviderEventBody,
  type ProviderRequest,
  type ProviderRuntime,
} from '#src/providers/contract.js';
import { TEST_CODEX_PLAN } from '../../helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '../../helpers/canonical-work-dir.js';

type TestProviderContext = typeof TEST_CODEX_PLAN;
type TestProvider = Provider<TestProviderContext>;
type TestRuntime = ProviderRuntime<TestProviderContext>;

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'compose-terminal-once',
  prompt: 'hello',
  cwd: fixtureCanonicalWorkDir(process.cwd()),
  bypassPermissions: false,
  coralEnv: {},
};

const BASE_RUNTIME: TestRuntime = {
  transport: 'standalone',
  signal: new AbortController().signal,
  runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
  time: {
    now: () => 0,
    setTimeout: () => ({ unref: () => {} }),
    clearTimeout: () => {},
  } as TestRuntime['time'],
  ids: { uuid: () => 'test-uuid', sha256: () => 'sha256:fake' },
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
const SUSPENDED: ProviderEventBody = { kind: 'suspended', reason: 'interrupt_unconfirmed' };

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
  it('synthesizes a wrapper_lost terminal when the inner stream closes without one', async () => {
    const stream = compose([], fromEvents([PROGRESS]))(BASE_REQUEST, BASE_RUNTIME);

    const collected: ProviderEventBody[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    expect(collected).toEqual([PROGRESS, WRAPPER_LOST_TERMINAL]);
  });

  it('accepts suspension as a final disposition without synthesizing a terminal', async () => {
    const stream = compose([], fromEvents([PROGRESS, SUSPENDED, COMPLETED_TERMINAL]))(BASE_REQUEST, BASE_RUNTIME);

    const collected: ProviderEventBody[] = [];
    for await (const event of stream) collected.push(event);

    expect(collected).toEqual([PROGRESS, SUSPENDED]);
  });

  it('closes the owned inner iterator when a consumer returns after the terminal', async () => {
    let cleanedUp = false;
    const never = new Promise<void>(() => {});
    const provider: TestProvider = async function* terminalThenWaitProvider() {
      try {
        yield COMPLETED_TERMINAL;
        await never;
      } finally {
        cleanedUp = true;
      }
    };
    const iterator = compose([], provider)(BASE_REQUEST, BASE_RUNTIME)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: COMPLETED_TERMINAL });
    await iterator.return?.();

    expect(cleanedUp).toBe(true);
  });
});
