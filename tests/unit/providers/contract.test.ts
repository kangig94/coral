import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { sessionContinuityMutationSchema, type SessionContinuityMutation } from '#src/sessions/continuity-mutation.js';
import {
  compose,
  providerArtifactHandleEventBodySchema,
  providerFailureCauseSchema,
  providerContinuityEventBodySchema,
  providerTerminalEventBodySchema,
  type Provider,
  type ProviderArtifactHandleEventBody,
  type ProviderContinuityEventBody,
  type ProviderEventBody,
  type ProviderMiddleware,
  type ProviderRequest,
  type ProviderRuntime,
  type ProviderTerminalOutcome,
  type UsageSummary,
  providerTerminalOutcomeSchema,
  usageSummarySchema,
} from '#src/providers/contract.js';
import type { ProviderFailureCause } from '#src/providers/fault.js';
import { TEST_CODEX_CONTEXT } from '../../helpers/provider-credentials.js';

type TestProviderContext = typeof TEST_CODEX_CONTEXT;
type TestProvider = Provider<TestProviderContext>;
type TestProviderMiddleware = ProviderMiddleware<TestProviderContext>;
type TestRuntime = ProviderRuntime<TestProviderContext>;

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

function expectTypeParity<_T extends true>(): void {}

function deriveTotalTokens(usage: UsageSummary): number {
  if (
    usage.inputTokens === undefined ||
    usage.cacheReadTokens === undefined ||
    usage.cacheWriteTokens === undefined ||
    usage.outputTokens === undefined
  ) {
    throw new Error('complete token usage is required to derive a total');
  }
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

const BASE_REQUEST: ProviderRequest = {
  action: 'exec',
  sessionId: 'job-contract',
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
  acquireServer: async () => {
    throw new Error('not used in contract tests');
  },
  storage: { existsSync: () => true } as unknown as TestRuntime['storage'],
  continuityBridge: {
    checkpoint: () => {},
    transportClosed: () => {},
  },
  kbRoot: '/mock/kb',
  providerContext: TEST_CODEX_CONTEXT,
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
  it('wraps middleware outermost-first and preserves next() semantics', async () => {
    const calls: string[] = [];
    const provider: TestProvider = async function* leaf() {
      calls.push('leaf');
      yield { kind: 'progress', message: 'leaf-progress' };
      yield terminal('leaf-terminal');
    };
    const outer: TestProviderMiddleware = (next) =>
      async function* outerLayer(request, runtime) {
        calls.push(`outer:before:${request.sessionId}`);
        for await (const event of next(request, runtime)) {
          calls.push(`outer:event:${event.kind}`);
          yield event;
        }
        calls.push('outer:after');
      };
    const inner: TestProviderMiddleware = (next) =>
      async function* innerLayer(request, runtime) {
        calls.push(`inner:before:${request.sessionId}`);
        for await (const event of next(request, runtime)) {
          calls.push(`inner:event:${event.kind}`);
          yield event;
        }
        calls.push('inner:after');
      };

    const events = await collect(compose(outer, inner, provider)(BASE_REQUEST, BASE_RUNTIME));

    expect(events).toEqual([{ kind: 'progress', message: 'leaf-progress' }, terminal('leaf-terminal')]);
    expect(calls).toEqual([
      'outer:before:job-contract',
      'inner:before:job-contract',
      'leaf',
      'inner:event:progress',
      'outer:event:progress',
      'inner:event:terminal',
      'outer:event:terminal',
      'inner:after',
      'outer:after',
    ]);
  });

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

  it('type-checks the array and variadic compose forms and narrows by event kind', async () => {
    const provider: TestProvider = async function* typedLeaf() {
      yield { kind: 'continuity', conversationRef: 'conversation-1', resumable: true, providerContinuity: {} };
      yield terminal('typed');
    };
    const passthrough: TestProviderMiddleware = (next) => next;

    const fromArray = compose([], provider);
    const fromVariadic = compose(passthrough, provider);
    const events = await collect(fromVariadic(BASE_REQUEST, BASE_RUNTIME));

    const rendered = events.map((event) => {
      switch (event.kind) {
        case 'progress':
          return event.message;
        case 'continuity':
          return event.conversationRef ?? 'none';
        case 'artifact_handle':
          return event.handle;
        case 'terminal':
          return event.terminal.content;
      }
    });

    expect(typeof fromArray).toBe('function');
    expect(rendered).toEqual(['conversation-1', 'typed']);
  });
});

describe('contract schemas', () => {
  it('parses canonical usage and derives totals from additive token buckets', () => {
    const parsed = usageSummarySchema.parse({
      inputTokens: 11,
      cacheReadTokens: 17,
      cacheWriteTokens: 19,
      outputTokens: 23,
      costUsd: 0.42,
    });

    expect(parsed).toEqual({
      inputTokens: 11,
      cacheReadTokens: 17,
      cacheWriteTokens: 19,
      outputTokens: 23,
      costUsd: 0.42,
    });
    expect(deriveTotalTokens(parsed)).toBe(70);
    expect(parsed).not.toHaveProperty('totalTokens');
  });

  it('keeps cost-only usage payloads valid', () => {
    expect(usageSummarySchema.parse({ costUsd: 0.34 })).toEqual({ costUsd: 0.34 });
  });

  it('rejects raw Anthropic usage and stored totals at the provider boundary', () => {
    const rawAnthropicUsage = {
      input_tokens: 11,
      cache_creation: {
        ephemeral_5m_input_tokens: 13,
      },
      cache_read_input_tokens: 17,
      output_tokens: 23,
      server_tool_use: {
        web_search_requests: 1,
      },
      costUsd: 0.42,
    };

    expect(usageSummarySchema.safeParse(rawAnthropicUsage).success).toBe(false);
    expect(usageSummarySchema.safeParse({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }).success).toBe(false);
  });

  it('requires cache token buckets to be nonnegative integers', () => {
    expect(usageSummarySchema.safeParse({ cacheReadTokens: -1 }).success).toBe(false);
    expect(usageSummarySchema.safeParse({ cacheWriteTokens: 1.5 }).success).toBe(false);
  });

  it('keeps zod inference aligned with the native failure cause and continuity types', () => {
    expectTypeParity<IsEqual<z.infer<typeof usageSummarySchema>, UsageSummary>>();
    expectTypeParity<IsEqual<z.infer<typeof providerTerminalOutcomeSchema>, ProviderTerminalOutcome>>();
    expectTypeParity<IsEqual<z.infer<typeof providerFailureCauseSchema>, ProviderFailureCause>>();
    expectTypeParity<IsEqual<z.infer<typeof providerContinuityEventBodySchema>, ProviderContinuityEventBody>>();
    expectTypeParity<IsEqual<z.infer<typeof providerArtifactHandleEventBodySchema>, ProviderArtifactHandleEventBody>>();
    expectTypeParity<IsEqual<z.infer<typeof sessionContinuityMutationSchema>, SessionContinuityMutation>>();

    const failed = providerTerminalOutcomeSchema.parse({
      kind: 'failed',
    });
    const failureCause = providerFailureCauseSchema.parse({
      type: 'session.provider_failed',
      body: {
        provider: 'claude',
        reason: 'request_failed',
        message: 'dispatch rejected',
      },
    });
    const continuity = providerContinuityEventBodySchema.parse({
      kind: 'continuity',
      conversationRef: 'conversation-1',
      resumable: true,
      providerContinuity: {
        conversationRef: 'conversation-1',
      },
    });
    const artifactHandle = providerArtifactHandleEventBodySchema.parse({
      kind: 'artifact_handle',
      handle: '/tmp/provider.jsonl',
      identity: { kind: 'test-artifact', path: '/tmp/provider.jsonl' },
    });
    const continuityMutation = sessionContinuityMutationSchema.parse({
      kind: 'set_resumable',
      conversationRef: 'conversation-1',
      providerContinuity: {
        conversationRef: 'conversation-1',
      },
    });

    expect(failed).toEqual({
      kind: 'failed',
    });
    expect(failureCause).toEqual({
      type: 'session.provider_failed',
      body: {
        provider: 'claude',
        reason: 'request_failed',
        message: 'dispatch rejected',
      },
    });
    expect(continuity).toEqual({
      kind: 'continuity',
      conversationRef: 'conversation-1',
      resumable: true,
      providerContinuity: {
        conversationRef: 'conversation-1',
      },
    });
    expect(artifactHandle).toEqual({
      kind: 'artifact_handle',
      handle: '/tmp/provider.jsonl',
      identity: { kind: 'test-artifact', path: '/tmp/provider.jsonl' },
    });
    expect(continuityMutation).toEqual({
      kind: 'set_resumable',
      conversationRef: 'conversation-1',
      providerContinuity: {
        conversationRef: 'conversation-1',
      },
    });
  });

  it('rejects aborted outcomes and failure causes that fall outside the contract', () => {
    const invalidAbort = providerTerminalOutcomeSchema.safeParse({
      kind: 'aborted',
      reason: 'timeout',
    });
    const invalidFailureCause = providerFailureCauseSchema.safeParse({
      type: 'session.provider_failed',
      body: {
        provider: 'claude',
        message: 'wrong field',
      },
    });
    const invalidContinuity = providerContinuityEventBodySchema.safeParse({
      kind: 'continuity',
      conversationRef: null,
      resumable: true,
      providerContinuity: 'not-an-object',
    });
    const invalidContinuityMutation = sessionContinuityMutationSchema.safeParse({
      kind: 'preserve',
      extra: true,
    });

    expect(invalidAbort.success).toBe(false);
    expect(invalidFailureCause.success).toBe(false);
    expect(invalidContinuity.success).toBe(false);
    expect(invalidContinuityMutation.success).toBe(false);
  });

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
