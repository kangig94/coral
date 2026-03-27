import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../discuss/events.js';
import type { BidResult, SpeechResult } from '../../discuss/types.js';
import type { McpResult } from '../../shared/mcp-utils.js';
import * as discussLoop from '../discuss/loop.js';
import {
  createDiscussContextRegistry,
  get as getDiscussContext,
  getOrCreate as getOrCreateDiscussContext,
  type DiscussContextRegistry,
} from '../discuss/context-registry.js';
import { getSession } from '../discuss/registry.js';
import { routeToolCall } from '../server.js';
import type { CallerContext, ExecutionService } from '../service.js';
import {
  DEFAULT_TOPIC,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  defaultAgents,
  persistSession,
} from './discuss-test-helpers.js';

function createHelpers(
  registry: DiscussContextRegistry,
  stores: Map<string, ReturnType<typeof createDiscussHarness>['store']>,
  service: ExecutionService,
) {
  return {
    getExecutionService: (_ctx: CallerContext) => service,
    getDiscussContext: (ctx: CallerContext) => {
      const store = stores.get(ctx.projectRoot);
      if (!store) {
        throw new Error(`Missing discuss store for ${ctx.projectRoot}`);
      }
      return getOrCreateDiscussContext(registry, ctx.projectRoot, service, store);
    },
    abortJobs: (_jobIds: string[]) => ({ aborted: [], notFound: [] }),
    scopeCheckJobs: (_jobIds: string[], _projectRoot: string) => ({ valid: [], missing: [], mismatch: [] }),
  };
}

function parseMcpBody<T>(result: { statusCode: number; body: unknown }): T {
  expect(result.statusCode).toBe(200);
  const body = result.body as McpResult;
  expect(body.isError).toBe(false);
  return JSON.parse(body.content[0].text) as T;
}

function parseMcpError(result: { statusCode: number; body: unknown }): Record<string, unknown> {
  expect(result.statusCode).toBe(200);
  const body = result.body as McpResult;
  expect(body.isError).toBe(true);
  return JSON.parse(body.content[0].text) as Record<string, unknown>;
}

async function createWatchToolFixture(sessionId = 'discuss-1') {
  const harness = createDiscussHarness();
  const registry = createDiscussContextRegistry();
  const context = getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);
  const stores = new Map([[harness.projectRoot, harness.store]]);
  await persistSession({ ...harness, context }, {
    sessionId,
    recover: true,
    buildTail: (snapshot) => [
      makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.submitted', '2026-03-10T00:01:00.000Z', { agent: 'alpha', score: 88, thought: 'keep sealed' }),
      makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'bid.submitted', '2026-03-10T00:01:01.000Z', { agent: 'beta', score: 42, thought: 'also sealed' }),
      makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-10T00:01:02.000Z', {
        allBids: { alpha: 88, beta: 42 },
        effectiveBids: { alpha: 88, beta: 42 },
        thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
        outcome: { winner: 'alpha', speaker_type: 'quota' as const },
        stateMutations: { cold_start: false },
      }),
      makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 4, 'speech.recorded', '2026-03-10T00:01:03.000Z', {
        agent: 'alpha',
        content: 'Open the street to buses and bikes first.',
        decrementQuota: true,
        recordLastSpeechStep: 1,
      }),
    ],
    });
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
    const harness = createDiscussHarness(createExecutionServiceStub({
      start: vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-1' }),
      waitStreamOnce: vi.fn().mockResolvedValue({ content: '{"score": 61, "thought": "alpha"}', nonResumable: false }),
    }));
    const registry = createDiscussContextRegistry();
    getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => {});
    const stores = new Map([[harness.projectRoot, harness.store]]);

    const result = await routeToolCall({
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
    }, createHelpers(registry, stores, harness.service));

    const parsed = parseMcpBody<{ session: string }>(result);
    expect(parsed.session).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getSession(getDiscussContext(registry, harness.projectRoot)!, parsed.session)).toBeDefined();

    harness.cleanup();
  });

  it('discuss_abort appends a terminal state and detaches the live session', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);
    const stores = new Map([[harness.projectRoot, harness.store]]);
    await persistSession({ ...harness, context }, { sessionId: 'discuss-1', recover: true });

    const result = await routeToolCall({
      name: 'discuss_abort',
      args: { session: 'discuss-1' },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    expect(parseMcpBody<{ ok: boolean; session: string }>(result)).toEqual({
      ok: true,
      session: 'discuss-1',
    });
    expect(harness.store.load('discuss-1')?.state.status).toBe('ended');
    expect(getSession(context, 'discuss-1')).toBeUndefined();

    harness.cleanup();
  });

  it('discuss_watch returns the committed watch history', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1' },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    const parsed = parseMcpBody<{
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
    const context = getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);
    const stores = new Map([[harness.projectRoot, harness.store]]);
    await persistSession({ ...harness, context }, {
      sessionId: 'discuss-epoch',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.round.closed', '2026-03-10T00:02:00.000Z', {
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
        }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'session.ended', '2026-03-10T00:02:01.000Z', {
          force: true,
          reason: 'abort',
        }),
      ],
    });

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-epoch' },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    const parsed = parseMcpBody<{
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

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1', cursor: 0 },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    const parsed = parseMcpBody<{
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

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1', cursor: 1 },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    const parsed = parseMcpBody<{
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

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1', cursor: 2 },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    const parsed = parseMcpBody<{
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

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1', cursor: 3 },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    expect(parseMcpError(result)).toEqual({
      error: 'invalid_cursor',
      cursor: 3,
      max: 2,
    });

    harness.cleanup();
  });

  it('discuss_watch with cursor=-1 returns Zod validation error (invalid_request)', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1', cursor: -1 },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));
    const error = parseMcpError(result);

    expect(error).toMatchObject({ error: 'invalid_request' });
    expect(String(error.message)).toContain('cursor');

    harness.cleanup();
  });

  it('discuss_watch with cursor=1.5 returns Zod validation error (invalid_request)', async () => {
    const { harness, registry, stores } = await createWatchToolFixture();

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1', cursor: 1.5 },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));
    const error = parseMcpError(result);

    expect(error).toMatchObject({ error: 'invalid_request' });
    expect(String(error.message)).toContain('cursor');

    harness.cleanup();
  });

  it('discuss_participate records a manual observer bid through the store-backed manager', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);
    const stores = new Map([[harness.projectRoot, harness.store]]);
    await persistSession({ ...harness, context }, {
      sessionId: 'discuss-1',
      recover: true,
      agents: [
        ...defaultAgents(),
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.submitted', '2026-03-10T00:01:00.000Z', { agent: 'alpha', score: 71, thought: 'alpha' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'bid.submitted', '2026-03-10T00:01:01.000Z', { agent: 'beta', score: 44, thought: 'beta' }),
      ],
    });

    const result = await routeToolCall({
      name: 'discuss_participate',
      args: {
        session: 'discuss-1',
        agent_name: 'user',
        score: 63,
        thought: 'I need to answer the accessibility concern.',
      },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    expect(parseMcpBody<BidResult>(result)).toEqual({
      action: 'listen',
      speaker: null,
      content: 'Bid recorded.',
    });
    expect(harness.store.load('discuss-1')?.state.current_bids.user).toBe(63);

    harness.cleanup();
  });

  it('discuss_participate records speech and enforces turn ownership', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const context = getOrCreateDiscussContext(registry, harness.projectRoot, harness.service, harness.store);
    const stores = new Map([[harness.projectRoot, harness.store]]);
    await persistSession({ ...harness, context }, {
      sessionId: 'discuss-valid',
      recover: true,
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.submitted', '2026-03-10T00:01:00.000Z', { agent: 'alpha', score: 40, thought: 'alpha' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'bid.submitted', '2026-03-10T00:01:01.000Z', { agent: 'user', score: 80, thought: 'user' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-10T00:01:02.000Z', {
          allBids: { alpha: 40, user: 80 },
          effectiveBids: { alpha: 40, user: 80 },
          thoughts: { alpha: 'alpha', user: 'user' },
          outcome: { winner: 'user', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
      ],
    });
    await persistSession({ ...harness, context }, {
      sessionId: 'discuss-invalid',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.submitted', '2026-03-10T00:02:00.000Z', { agent: 'alpha', score: 80, thought: 'alpha' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'bid.submitted', '2026-03-10T00:02:01.000Z', { agent: 'beta', score: 70, thought: 'beta' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-10T00:02:02.000Z', {
          allBids: { alpha: 80, beta: 70 },
          effectiveBids: { alpha: 80, beta: 70 },
          thoughts: { alpha: 'alpha', beta: 'beta' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
      ],
    });

    const validResult = await routeToolCall({
      name: 'discuss_participate',
      args: {
        session: 'discuss-valid',
        agent_name: 'user',
        content: 'My speech answers the accessibility concern directly.',
      },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));
    const invalidResult = await routeToolCall({
      name: 'discuss_participate',
      args: {
        session: 'discuss-invalid',
        agent_name: 'user',
        content: 'This should be rejected.',
      },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    expect(parseMcpBody<SpeechResult>(validResult)).toEqual({ action: 'speech_recorded' });
    expect(parseMcpBody<SpeechResult>(invalidResult)).toEqual({
      action: 'not_your_turn',
      current_speaker: 'alpha',
    });

    harness.cleanup();
  });

  it('returns session_not_found when a discuss tool targets an unknown session', async () => {
    const harness = createDiscussHarness();
    const registry = createDiscussContextRegistry();
    const stores = new Map([[harness.projectRoot, harness.store]]);

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'missing' },
      context: harness.ctx,
    }, createHelpers(registry, stores, harness.service));

    expect(parseMcpError(result)).toEqual({
      error: 'session_not_found',
      session: 'missing',
    });

    harness.cleanup();
  });
});
