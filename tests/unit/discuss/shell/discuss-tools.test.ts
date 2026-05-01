import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '#src/discuss/events.js';
import type { BidResult, SpeechResult } from '#src/discuss/session-types.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import {
  createDiscussContextRegistry,
  get as getDiscussContext,
  getOrCreate as getOrCreateDiscussContext,
  type DiscussContextRegistry,
} from '#src/discuss/shell/live-registry.js';
import type { DiscussContext } from '#src/discuss/shell/types.js';
import {
  handleDiscussAbort,
  handleDiscussBid,
  handleDiscussSeed,
  handleDiscussSpeech,
  handleDiscussStart,
  handleDiscussWatch,
} from '#src/discuss/shell/tools.js';
import { getSession } from '#src/discuss/shell/registry.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { ExecutionService } from '#src/coordinator/execution-service.js';
import type { ToolDomainResult } from '#src/transport/tool-result.js';
import {
  DEFAULT_TOPIC,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  defaultAgents,
  discussContextOptions,
  persistSession,
  type DiscussHarness,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';

function createHelpers(
  registry: DiscussContextRegistry,
  stores: Map<string, DiscussHarness>,
  service: ExecutionService,
) {
  return {
    getExecutionService: (_ctx: InvocationContext) => service,
    getDiscussContext: (ctx: InvocationContext) => {
      const harness = stores.get(ctx.projectRoot);
      if (!harness) {
        throw new Error(`Missing discuss store for ${ctx.projectRoot}`);
      }
      return getOrCreateDiscussContext(
        registry,
        ctx.projectRoot,
        service,
        harness.store,
        discussContextOptions(harness),
      );
    },
    abortJobs: (_jobIds: string[]) => ({ aborted: [], notFound: [] }),
    scopeCheckJobs: (_jobIds: string[], _projectRoot: string) => ({ valid: [], missing: [], mismatch: [] }),
  };
}

function parseToolBody<T>(result: ToolDomainResult): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Unexpected tool error: ${result.code}`);
  }
  return result.data as T;
}

function parseToolError(result: ToolDomainResult): Record<string, unknown> {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected tool error');
  }
  const detail = result.detail;
  if (detail && typeof detail === 'object') {
    return { error: result.code, message: result.message, ...(detail as Record<string, unknown>) };
  }
  return { error: result.code, message: result.message };
}

async function callDiscussTool(
  request: {
    name: 'discuss_seed' | 'discuss_start' | 'discuss_abort' | 'discuss_watch' | 'discuss_bid' | 'discuss_speech';
    args: Record<string, unknown>;
    context: InvocationContext;
  },
  helpers: { getDiscussContext: (ctx: InvocationContext) => DiscussContext },
): Promise<ToolDomainResult> {
  switch (request.name) {
    case 'discuss_seed':
      return handleDiscussSeed(request.args);
    case 'discuss_start':
      return handleDiscussStart(request.args, request.context, helpers);
    case 'discuss_abort':
      return handleDiscussAbort(request.args, request.context, helpers);
    case 'discuss_watch':
      return Promise.resolve(handleDiscussWatch(request.args, request.context, helpers));
    case 'discuss_bid':
      return handleDiscussBid(request.args, request.context, helpers);
    case 'discuss_speech':
      return handleDiscussSpeech(request.args, request.context, helpers);
  }
}

async function createWatchToolFixture(sessionId = 'discuss-1') {
  const harness = createDiscussHarness();
  const registry = createDiscussContextRegistry();
  const context = getOrCreateDiscussContext(
    registry,
    harness.projectRoot,
    harness.service,
    harness.store,
    discussContextOptions(harness),
  );
  const stores = new Map([[harness.projectRoot, harness]]);
  await persistSession(
    { ...harness, context },
    {
      sessionId,
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', score: 88, thought: 'keep sealed' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-10T00:01:01.000Z',
          { agent: 'beta', score: 42, thought: 'also sealed' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-10T00:01:02.000Z',
          {
            allBids: { alpha: 88, beta: 42 },
            effectiveBids: { alpha: 88, beta: 42 },
            thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 4,
          'speech.recorded',
          '2026-03-10T00:01:03.000Z',
          {
            agent: 'alpha',
            content: 'Open the street to buses and bikes first.',
            decrementQuota: true,
            recordLastSpeechStep: 1,
          },
        ),
      ],
    },
  );
  return { harness, registry, stores };
}

describe('execution discuss tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanupDiscussHarnesses();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('discuss_start creates a live session and returns its id', async () => {
    const harness = createDiscussHarness(
      createExecutionServiceStub({
        start: vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-1' }),
        waitStreamOnce: vi.fn().mockResolvedValue({ content: '{"score": 61, "thought": "alpha"}', continuity: null }),
      }),
    );
    const registry = createDiscussContextRegistry();
    getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const stores = new Map([[harness.projectRoot, harness]]);

    const result = await callDiscussTool(
      {
        name: 'discuss_start',
        args: {
          topic: DEFAULT_TOPIC,
          agents: [
            { name: 'alpha', persona: '# Alpha', provider: 'codex' },
            { name: 'beta', persona: '# Beta', provider: 'codex' },
            { name: 'user', persona: '# User', participation: 'observer' },
          ],
        },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    const parsed = parseToolBody<{ session: string }>(result);
    expect(parsed.session).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getSession(getDiscussContext(registry, harness.projectRoot)!, parsed.session)).toBeDefined();

    harness.cleanup();
  });

  it('discuss_abort appends a terminal state and detaches the live session', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );
    const stores = new Map([[harness.projectRoot, harness]]);
    await persistSession({ ...harness, context }, { sessionId: 'discuss-1', recover: true });

    const result = await callDiscussTool(
      {
        name: 'discuss_abort',
        args: { session: 'discuss-1' },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    expect(parseToolBody<{ ok: boolean; session: string }>(result)).toEqual({
      ok: true,
      session: 'discuss-1',
    });
    expect(harness.store.load('discuss-1')?.state.status).toBe('ended');
    expect(getSession(context, 'discuss-1')).toBeUndefined();

    harness.cleanup();
  });

  it('discuss_watch returns the committed watch history', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-1' },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    const parsed = parseToolBody<{
      session: string;
      status: string;
      topic: string;
      epoch: number;
      step: number;
      events: Array<Record<string, unknown>>;
    }>(result);

    expect(parsed).toEqual({
      session: 'discuss-1',
      status: 'bidding',
      topic: DEFAULT_TOPIC,
      epoch: 1,
      step: 2,
      cursor: 2,
      events: [
        {
          type: 'bid_resolved',
          data: { winner: 'alpha', speaker_type: 'quota' as const },
          ts: Date.parse('2026-03-10T00:01:02.000Z'),
        },
        {
          type: 'speech_done',
          data: { speaker: 'alpha', content: 'Open the street to buses and bikes first.' },
          ts: Date.parse('2026-03-10T00:01:03.000Z'),
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('thoughts');

    harness.cleanup();
  });

  it('discuss_watch preserves immediate epoch_transition ordering from committed batches', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );
    const stores = new Map([[harness.projectRoot, harness]]);
    await persistSession(
      { ...harness, context },
      {
        sessionId: 'discuss-epoch',
        recover: true,
        buildTail: (snapshot) => [
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 1,
            'bid.round.closed',
            '2026-03-10T00:02:00.000Z',
            {
              allBids: { alpha: 4, beta: 3 },
              effectiveBids: { alpha: 4, beta: 3 },
              thoughts: { alpha: 'spent', beta: 'spent' },
              outcome: { no_winner: true as const, reason: 'epoch_transition' as const },
              stateMutations: {
                epoch: 2,
                cold_start: false,
                fallback_used: { alpha: true, beta: true },
                quota_remaining: { alpha: 0, beta: 0 },
              },
            },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 2,
            'session.ended',
            '2026-03-10T00:02:01.000Z',
            {
              force: true,
              reason: 'abort',
            },
          ),
        ],
      },
    );

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-epoch' },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    const parsed = parseToolBody<{
      session: string;
      status: string;
      topic: string;
      epoch: number;
      step: number;
      events: Array<Record<string, unknown>>;
      cursor: number;
    }>(result);

    expect(parsed).toMatchObject({
      session: 'discuss-epoch',
      status: 'ended',
      topic: DEFAULT_TOPIC,
      epoch: 2,
      cursor: 2,
    });
    expect(parsed.events).toEqual([
      {
        type: 'epoch_transition',
        data: { epoch: 2 },
        ts: Date.parse('2026-03-10T00:02:00.000Z'),
      },
      {
        type: 'session_ended',
        data: { reason: 'force_end', detail: 'abort' },
        ts: Date.parse('2026-03-10T00:02:01.000Z'),
      },
    ]);

    harness.cleanup();
  });

  it('discuss_watch with cursor=0 returns full history and cursor count', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-1', cursor: 0 },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    const parsed = parseToolBody<{
      session: string;
      status: string;
      topic: string;
      epoch: number;
      step: number;
      events: Array<Record<string, unknown>>;
      cursor: number;
    }>(result);

    expect(parsed).toEqual({
      session: 'discuss-1',
      status: 'bidding',
      topic: DEFAULT_TOPIC,
      epoch: 1,
      step: 2,
      cursor: 2,
      events: [
        {
          type: 'bid_resolved',
          data: { winner: 'alpha', speaker_type: 'quota' as const },
          ts: Date.parse('2026-03-10T00:01:02.000Z'),
        },
        {
          type: 'speech_done',
          data: { speaker: 'alpha', content: 'Open the street to buses and bikes first.' },
          ts: Date.parse('2026-03-10T00:01:03.000Z'),
        },
      ],
    });

    harness.cleanup();
  });

  it('discuss_watch with cursor=N returns only incremental events', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-1', cursor: 1 },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    const parsed = parseToolBody<{
      session: string;
      status: string;
      topic: string;
      epoch: number;
      step: number;
      events: Array<Record<string, unknown>>;
      cursor: number;
    }>(result);

    expect(parsed).toMatchObject({
      session: 'discuss-1',
      status: 'bidding',
      topic: DEFAULT_TOPIC,
      epoch: 1,
      step: 2,
      cursor: 2,
    });
    expect(parsed.events).toEqual([
      {
        type: 'speech_done',
        data: { speaker: 'alpha', content: 'Open the street to buses and bikes first.' },
        ts: Date.parse('2026-03-10T00:01:03.000Z'),
      },
    ]);

    harness.cleanup();
  });

  it('discuss_watch with cursor equal to events length returns empty events and same cursor', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-1', cursor: 2 },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    const parsed = parseToolBody<{
      session: string;
      status: string;
      topic: string;
      epoch: number;
      step: number;
      events: Array<Record<string, unknown>>;
      cursor: number;
    }>(result);

    expect(parsed).toMatchObject({
      session: 'discuss-1',
      status: 'bidding',
      topic: DEFAULT_TOPIC,
      epoch: 1,
      step: 2,
      cursor: 2,
    });
    expect(parsed.events).toEqual([]);

    harness.cleanup();
  });

  it('discuss_watch with cursor greater than events length returns invalid_cursor error', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-1', cursor: 3 },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    expect(parseToolError(result)).toEqual({
      error: 'invalid_cursor',
      message: 'invalid cursor',
      cursor: 3,
      max: 2,
    });

    harness.cleanup();
  });

  it('discuss_watch with cursor=-1 returns Zod validation error (invalid_request)', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-1', cursor: -1 },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );
    const error = parseToolError(result);

    expect(error).toMatchObject({ error: 'invalid_request' });
    expect(String(error.message)).toContain('cursor');

    harness.cleanup();
  });

  it('discuss_watch with cursor=1.5 returns Zod validation error (invalid_request)', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'discuss-1', cursor: 1.5 },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );
    const error = parseToolError(result);

    expect(error).toMatchObject({ error: 'invalid_request' });
    expect(String(error.message)).toContain('cursor');

    harness.cleanup();
  });

  it('discuss_bid records a manual observer bid through the store-backed manager', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );
    const stores = new Map([[harness.projectRoot, harness]]);
    await persistSession(
      { ...harness, context },
      {
        sessionId: 'discuss-1',
        recover: true,
        agents: [...defaultAgents(), { name: 'user', persona: '# User', participation: 'observer' }],
        buildTail: (snapshot) => [
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 1,
            'bid.submitted',
            '2026-03-10T00:01:00.000Z',
            { agent: 'alpha', score: 71, thought: 'alpha' },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 2,
            'bid.submitted',
            '2026-03-10T00:01:01.000Z',
            { agent: 'beta', score: 44, thought: 'beta' },
          ),
        ],
      },
    );

    const result = await callDiscussTool(
      {
        name: 'discuss_bid',
        args: {
          session: 'discuss-1',
          agent_name: 'user',
          score: 63,
          thought: 'I need to answer the accessibility concern.',
        },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    expect(parseToolBody<BidResult>(result)).toEqual({
      action: 'listen',
      speaker: null,
      content: 'Bid recorded.',
    });
    expect(harness.store.load('discuss-1')?.state.current_bids.user).toBe(63);

    harness.cleanup();
  });

  it('discuss_speech records speech and enforces turn ownership', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(
      registry,
      harness.projectRoot,
      harness.service,
      harness.store,
      discussContextOptions(harness),
    );
    const stores = new Map([[harness.projectRoot, harness]]);
    await persistSession(
      { ...harness, context },
      {
        sessionId: 'discuss-valid',
        recover: true,
        agents: [
          { name: 'alpha', persona: '# Alpha', participation: 'required' },
          { name: 'user', persona: '# User', participation: 'observer' },
        ],
        buildTail: (snapshot) => [
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 1,
            'bid.submitted',
            '2026-03-10T00:01:00.000Z',
            { agent: 'alpha', score: 40, thought: 'alpha' },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 2,
            'bid.submitted',
            '2026-03-10T00:01:01.000Z',
            { agent: 'user', score: 80, thought: 'user' },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 3,
            'bid.round.closed',
            '2026-03-10T00:01:02.000Z',
            {
              allBids: { alpha: 40, user: 80 },
              effectiveBids: { alpha: 40, user: 80 },
              thoughts: { alpha: 'alpha', user: 'user' },
              outcome: { winner: 'user', speaker_type: 'quota' as const },
              stateMutations: { cold_start: false },
            },
          ),
        ],
      },
    );
    await persistSession(
      { ...harness, context },
      {
        sessionId: 'discuss-invalid',
        recover: true,
        buildTail: (snapshot) => [
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 1,
            'bid.submitted',
            '2026-03-10T00:02:00.000Z',
            { agent: 'alpha', score: 80, thought: 'alpha' },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 2,
            'bid.submitted',
            '2026-03-10T00:02:01.000Z',
            { agent: 'beta', score: 70, thought: 'beta' },
          ),
          makeEvent(
            snapshot.sessionId,
            harness.projectRoot,
            snapshot.state.topic,
            snapshot.lastAppliedSeq + 3,
            'bid.round.closed',
            '2026-03-10T00:02:02.000Z',
            {
              allBids: { alpha: 80, beta: 70 },
              effectiveBids: { alpha: 80, beta: 70 },
              thoughts: { alpha: 'alpha', beta: 'beta' },
              outcome: { winner: 'alpha', speaker_type: 'quota' as const },
              stateMutations: { cold_start: false },
            },
          ),
        ],
      },
    );

    const validResult = await callDiscussTool(
      {
        name: 'discuss_speech',
        args: {
          session: 'discuss-valid',
          agent_name: 'user',
          content: 'My speech answers the accessibility concern directly.',
        },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );
    const invalidResult = await callDiscussTool(
      {
        name: 'discuss_speech',
        args: {
          session: 'discuss-invalid',
          agent_name: 'user',
          content: 'This should be rejected.',
        },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    expect(parseToolBody<SpeechResult>(validResult)).toEqual({ action: 'speech_recorded' });
    expect(parseToolBody<SpeechResult>(invalidResult)).toEqual({
      action: 'not_your_turn',
      current_speaker: 'alpha',
    });

    harness.cleanup();
  });

  it('returns session_not_found when a discuss tool targets an unknown session', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const stores = new Map([[harness.projectRoot, harness]]);

    const result = await callDiscussTool(
      {
        name: 'discuss_watch',
        args: { session: 'missing' },
        context: harness.ctx,
      },
      createHelpers(registry, stores, harness.service),
    );

    expect(parseToolError(result)).toEqual({
      error: 'session_not_found',
      message: 'session not found',
      session: 'missing',
    });

    harness.cleanup();
  });

  describe('unexpectedDiscussError path', () => {
    it('discuss_abort returns discuss_error for non-DiscussManagerError', async () => {
      const harness = createDiscussHarness();
      const registry = createDiscussContextRegistry();
      const stores = new Map([[harness.projectRoot, harness]]);
      vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
      const context = getOrCreateDiscussContext(
        registry,
        harness.projectRoot,
        harness.service,
        harness.store,
        discussContextOptions(harness),
      );
      await persistSession({ ...harness, context }, { sessionId: 'sess-err' });

      // Make getSession throw a plain Error (simulates unexpected failure inside the operation)
      vi.spyOn(await import('#src/discuss/shell/registry.js'), 'getSession').mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      const result = await callDiscussTool(
        {
          name: 'discuss_abort',
          args: { session: 'sess-err' },
          context: harness.ctx,
        },
        createHelpers(registry, stores, harness.service),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('discuss_error');
        expect(result.message).toBe('disk full');
      }

      harness.cleanup();
    });

    it('discuss_watch returns discuss_error for non-DiscussManagerError', async () => {
      const harness = createDiscussHarness();
      const throwingHelpers = {
        getExecutionService: (_ctx: InvocationContext) => harness.service,
        getDiscussContext: (_ctx: InvocationContext): DiscussContext => {
          throw new TypeError('Cannot read property');
        },
        abortJobs: (_jobIds: string[]) => ({ aborted: [], notFound: [] }),
        scopeCheckJobs: (_jobIds: string[], _projectRoot: string) => ({ valid: [], missing: [], mismatch: [] }),
      };

      const result = await callDiscussTool(
        {
          name: 'discuss_watch',
          args: { session: 'sess-err2' },
          context: harness.ctx,
        },
        throwingHelpers,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('discuss_error');
        expect(result.message).toBe('Cannot read property');
      }

      harness.cleanup();
    });

    it('discuss_bid returns discuss_error for non-DiscussManagerError', async () => {
      const harness = createDiscussHarness();
      const throwingHelpers = {
        getExecutionService: (_ctx: InvocationContext) => harness.service,
        getDiscussContext: (_ctx: InvocationContext): DiscussContext => {
          throw new RangeError('out of bounds');
        },
        abortJobs: (_jobIds: string[]) => ({ aborted: [], notFound: [] }),
        scopeCheckJobs: (_jobIds: string[], _projectRoot: string) => ({ valid: [], missing: [], mismatch: [] }),
      };

      const result = await callDiscussTool(
        {
          name: 'discuss_bid',
          args: {
            session: 'sess-err3',
            agent_name: 'tester',
            score: 50,
            thought: 'test',
          },
          context: harness.ctx,
        },
        throwingHelpers,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('discuss_error');
        expect(result.message).toBe('out of bounds');
      }

      harness.cleanup();
    });

    it('discuss_speech returns discuss_error for non-DiscussManagerError', async () => {
      const harness = createDiscussHarness();
      const throwingHelpers = {
        getExecutionService: (_ctx: InvocationContext) => harness.service,
        getDiscussContext: (_ctx: InvocationContext): DiscussContext => {
          throw new RangeError('out of bounds');
        },
        abortJobs: (_jobIds: string[]) => ({ aborted: [], notFound: [] }),
        scopeCheckJobs: (_jobIds: string[], _projectRoot: string) => ({ valid: [], missing: [], mismatch: [] }),
      };

      const result = await callDiscussTool(
        {
          name: 'discuss_speech',
          args: { session: 'sess-err3', agent_name: 'tester', content: 'test' },
          context: harness.ctx,
        },
        throwingHelpers,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('discuss_error');
        expect(result.message).toBe('out of bounds');
      }

      harness.cleanup();
    });
  });
});
