import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initSession } from '../../discuss/state-machine.js';
import type { BidResult, DiscussState, SpeechResult } from '../../discuss/types.js';
import type { McpResult } from '../../shared/mcp-utils.js';
import { DiscussManagerRegistry } from '../discuss-manager.js';
import { routeToolCall } from '../server.js';
import type { CallerContext, ExecutionService } from '../service.js';

function createDiscussState(sessionId: string, overrides: Partial<DiscussState> = {}): DiscussState {
  return {
    ...initSession({
      topic: 'Should the city pedestrianize the downtown core?',
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'beta', persona: '# Beta', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      min_bid_delay_ms: 0,
    }, '2026-03-10T00:00:00.000Z'),
    session_id: sessionId,
    ...overrides,
  };
}

function createExecutionServiceStub(overrides: Partial<ExecutionService> = {}): ExecutionService {
  return {
    start: vi.fn(async () => ({
      status: 'running',
      job: 'job-1',
      session: 'exec-session-1',
    })),
    resume: vi.fn(async () => ({
      status: 'running',
      job: 'job-2',
      session: 'exec-session-2',
    })),
    waitStream: vi.fn(async function* () {}),
    waitStreamOnce: vi.fn(async () => {
      throw new Error('Job timed out waiting for terminal result');
    }),
    ...overrides,
  } as unknown as ExecutionService;
}

function createHelpers(registry: DiscussManagerRegistry, service: ExecutionService) {
  return {
    getExecutionService: (_ctx: CallerContext) => service,
    getDiscussManager: (ctx: CallerContext) => registry.getOrCreate(ctx.projectRoot, service),
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

const ctx: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
};

describe('execution discuss tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('discuss_seed returns PersonaSeedOutput', async () => {
    const registry = new DiscussManagerRegistry();
    const service = createExecutionServiceStub();

    const result = await routeToolCall({
      name: 'discuss_seed',
      args: {
        controversy_axes: [
          { axis: 'delivery', positions: ['incremental', 'rewrite'] },
          { axis: 'risk', positions: ['low', 'high'] },
        ],
        n: 3,
        seed: 7,
      },
      context: ctx,
    }, createHelpers(registry, service));

    const parsed = parseMcpBody<{
      seed_used: number;
      assignments: Array<Record<string, unknown>>;
    }>(result);

    expect(parsed.seed_used).toBe(7);
    expect(parsed.assignments).toHaveLength(3);
  });

  it('discuss_start creates a session and returns its id', async () => {
    const registry = new DiscussManagerRegistry();
    const service = createExecutionServiceStub();

    const result = await routeToolCall({
      name: 'discuss_start',
      args: {
        topic: 'Should the city pedestrianize the downtown core?',
        agents: [
          { name: 'alpha', persona: '# Alpha', provider: 'codex' },
          { name: 'beta', persona: '# Beta', provider: 'codex' },
          { name: 'user', persona: '# User', participation: 'observer' },
        ],
        config: { min_bid_delay_ms: 1000 },
      },
      context: ctx,
    }, createHelpers(registry, service));

    const parsed = parseMcpBody<{ session: string }>(result);
    const session = registry.get(ctx.projectRoot)?.getSession(parsed.session);

    expect(parsed.session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(session).toBeDefined();
  });

  it('discuss_abort aborts a live session', async () => {
    const registry = new DiscussManagerRegistry();
    const service = createExecutionServiceStub();
    const manager = registry.getOrCreate(ctx.projectRoot, service);
    const session = manager.createSession('discuss-1', createDiscussState('discuss-1'));

    const result = await routeToolCall({
      name: 'discuss_abort',
      args: { session: 'discuss-1' },
      context: ctx,
    }, createHelpers(registry, service));

    expect(parseMcpBody<{ ok: boolean; session: string }>(result)).toEqual({
      ok: true,
      session: 'discuss-1',
    });
    expect(session.controller.signal.aborted).toBe(true);
  });

  it('discuss_watch returns a redacted watch-log snapshot', async () => {
    const registry = new DiscussManagerRegistry();
    const service = createExecutionServiceStub();
    const manager = registry.getOrCreate(ctx.projectRoot, service);
    const session = manager.createSession('discuss-1', createDiscussState('discuss-1', {
      status: 'bidding',
      current_bids: { alpha: 88, beta: 42, user: 17 },
      current_thoughts: {
        alpha: 'keep this sealed',
        beta: 'also sealed',
        user: 'sealed',
      },
    }));
    manager.emitWatch('discuss-1', {
      type: 'bid_resolved',
      data: { winner: 'alpha', speaker_type: 'quota' },
      ts: 1_700_000_000_000,
    });
    session.watchLog.push({
      type: 'speech_done',
      data: { speaker: 'alpha', content: 'Open the street to buses and bikes first.' },
      ts: 1_700_000_000_500,
    });

    const result = await routeToolCall({
      name: 'discuss_watch',
      args: { session: 'discuss-1' },
      context: ctx,
    }, createHelpers(registry, service));

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
      topic: 'Should the city pedestrianize the downtown core?',
      epoch: 1,
      step: 1,
      events: [
        {
          type: 'bid_resolved',
          data: { winner: 'alpha', speaker_type: 'quota' },
          ts: 1_700_000_000_000,
        },
        {
          type: 'speech_done',
          data: { speaker: 'alpha', content: 'Open the street to buses and bikes first.' },
          ts: 1_700_000_000_500,
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('current_bids');
    expect(JSON.stringify(parsed)).not.toContain('current_thoughts');
    expect(JSON.stringify(parsed)).not.toContain('thoughts');
  });

  it('discuss_participate records a bid submission', async () => {
    const registry = new DiscussManagerRegistry();
    const service = createExecutionServiceStub();
    const manager = registry.getOrCreate(ctx.projectRoot, service);
    const session = manager.createSession('discuss-1', createDiscussState('discuss-1', {
      status: 'bidding',
      current_bids: { alpha: 71, beta: 44, user: null },
      current_thoughts: {
        alpha: 'I should go now.',
        beta: 'I can wait.',
      },
      pending_bidders: [],
    }));

    const result = await routeToolCall({
      name: 'discuss_participate',
      args: {
        session: 'discuss-1',
        agent_name: 'user',
        score: 63,
        thought: 'I need to answer the accessibility concern.',
      },
      context: ctx,
    }, createHelpers(registry, service));

    expect(parseMcpBody<BidResult>(result)).toEqual({
      action: 'listen',
      speaker: null,
      content: 'Bid recorded.',
    });
    expect(session.state.current_bids.user).toBe(63);
    expect(session.state.current_thoughts.user).toBe('I need to answer the accessibility concern.');
  });

  it('discuss_participate records speech and enforces turn ownership', async () => {
    const registry = new DiscussManagerRegistry();
    const service = createExecutionServiceStub();
    const manager = registry.getOrCreate(ctx.projectRoot, service);
    const validSession = manager.createSession('discuss-valid', createDiscussState('discuss-valid', {
      status: 'speaking',
      current_speaker: 'user',
      speaker_type: 'quota',
    }));
    manager.createSession('discuss-invalid', createDiscussState('discuss-invalid', {
      status: 'speaking',
      current_speaker: 'alpha',
      speaker_type: 'quota',
    }));

    const validResult = await routeToolCall({
      name: 'discuss_participate',
      args: {
        session: 'discuss-valid',
        agent_name: 'user',
        content: 'Start with bus-only weekends and measure transit throughput.',
      },
      context: ctx,
    }, createHelpers(registry, service));
    const invalidResult = await routeToolCall({
      name: 'discuss_participate',
      args: {
        session: 'discuss-invalid',
        agent_name: 'user',
        content: 'This should be rejected.',
      },
      context: ctx,
    }, createHelpers(registry, service));

    expect(parseMcpBody<SpeechResult>(validResult)).toEqual({ action: 'speech_recorded' });
    expect(validSession.state.status).toBe('bidding');
    expect(validSession.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'user',
      content: 'Start with bus-only weekends and measure transit throughput.',
    });
    expect(parseMcpBody<SpeechResult>(invalidResult)).toEqual({
      action: 'not_your_turn',
      current_speaker: 'alpha',
    });
  });

  it('returns validation errors through the MCP result wrapper', async () => {
    const registry = new DiscussManagerRegistry();
    const service = createExecutionServiceStub();

    const result = await routeToolCall({
      name: 'discuss_participate',
      args: {
        session: 'discuss-1',
        agent_name: 'user',
        score: 50,
        content: 'invalid mixed mode',
      },
      context: ctx,
    }, createHelpers(registry, service));

    expect(parseMcpError(result)).toMatchObject({ error: 'invalid_request' });
  });
});
