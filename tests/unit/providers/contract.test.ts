import { describe, expect, it } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  compose,
  providerTerminalEventBodySchema,
  type ProviderEventBody,
  type ProviderMiddleware,
  type ProviderRequest,
  type ProviderRuntime,
} from '#src/providers/contract.js';
import { TEST_CODEX_PLAN } from '../../helpers/provider-credentials.js';

type TestProviderContext = typeof TEST_CODEX_PLAN;
type TestProviderMiddleware = ProviderMiddleware<TestProviderContext>;
type TestRuntime = ProviderRuntime<TestProviderContext>;

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'job-contract',
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

function terminal(content: string): ProviderEventBody {
  return {
    kind: 'terminal',
    terminal: {
      content,
      durationMs: 0,
      outcome: { kind: 'completed' },
    },
    diagnostics: {},
  };
}

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('compose', () => {
  it('supports short-circuit middleware that never calls next()', async () => {
    const leaf = async function* (): AsyncIterable<ProviderEventBody> {
      throw new Error('leaf should not run');
    };
    const shortCircuit: TestProviderMiddleware = (_next) =>
      async function* shortCircuitLayer() {
        yield terminal('short-circuit');
      };

    const events = await collect(compose(shortCircuit, leaf)(BASE_REQUEST, BASE_RUNTIME));

    expect(events).toEqual([terminal('short-circuit')]);
  });
});

describe('contract schemas', () => {
  it('requires failureCause only for failed provider terminals', () => {
    expect(
      providerTerminalEventBodySchema.safeParse({
        kind: 'terminal',
        terminal: { content: '', outcome: { kind: 'failed' } },
        diagnostics: {},
      }).success,
    ).toBe(false);

    expect(
      providerTerminalEventBodySchema.safeParse({
        kind: 'terminal',
        terminal: { content: '', outcome: { kind: 'completed' } },
        diagnostics: {},
        failureCause: {
          type: 'session.provider_failed',
          body: { provider: 'claude', reason: 'request_failed', message: 'unexpected' },
        },
      }).success,
    ).toBe(false);
  });
});
