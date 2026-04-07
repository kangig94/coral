import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendHandle } from '../backend-lifecycle.js';
import { BackendClient, BackendToolHttpError, type CallerContext } from '../http-client.js';

const backendHandle: BackendHandle = {
  port: 4100,
  host: '127.0.0.1',
  token: 'backend-token',
  instanceId: 'backend-instance',
};

const defaultContext: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
  coralEnv: {},
};

describe('client http-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    {
      method: 'discussSeed',
      invoke: (client: BackendClient) =>
        client.discussSeed({
          controversy_axes: [{ axis: 'risk', positions: ['low', 'high'] }],
          n: 2,
          seed: 7,
        }),
      path: '/discuss/seed',
      args: {
        controversy_axes: [{ axis: 'risk', positions: ['low', 'high'] }],
        n: 2,
        seed: 7,
      },
    },
    {
      method: 'discussStart',
      invoke: (client: BackendClient) =>
        client.discussStart({
          topic: 'Should the bridge be removed?',
          agents: [
            { name: 'alice', persona: 'Architect' },
            { name: 'bob', persona: 'Operator', provider: 'codex', model: 'gpt-5' },
          ],
          config: { min_bid_delay_ms: 300 },
        }),
      path: '/discuss/start',
      args: {
        topic: 'Should the bridge be removed?',
        agents: [
          { name: 'alice', persona: 'Architect' },
          { name: 'bob', persona: 'Operator', provider: 'codex', model: 'gpt-5' },
        ],
        config: { min_bid_delay_ms: 300 },
      },
    },
    {
      method: 'discussWatch',
      invoke: (client: BackendClient) => client.discussWatch('session-1', 5),
      path: '/discuss/watch',
      args: { session: 'session-1', cursor: 5 },
    },
    {
      method: 'discussParticipate',
      invoke: (client: BackendClient) =>
        client.discussParticipate({
          session: 'session-1',
          agent_name: 'alice',
          score: 42,
          thought: 'Speak now.',
        }),
      path: '/discuss/participate',
      args: {
        session: 'session-1',
        agent_name: 'alice',
        score: 42,
        thought: 'Speak now.',
      },
    },
    {
      method: 'discussAbort',
      invoke: (client: BackendClient) => client.discussAbort('session-1'),
      path: '/discuss/abort',
      args: { session: 'session-1' },
    },
  ])('routes $method through the dedicated discuss endpoint', async ({ invoke, path, args }) => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(invoke(client)).resolves.toEqual({ ok: true, data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4100${path}`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          context: defaultContext,
          args,
        }),
      }),
    );
  });

  it.each([
    {
      method: 'kbSearch',
      invoke: (client: BackendClient) => client.kbSearch({ query: 'accel' }),
      path: '/kb/search',
      args: { query: 'accel' },
    },
    {
      method: 'kbPrinciples',
      invoke: (client: BackendClient) => client.kbPrinciples({ query: 'contract', top_k: 5 }),
      path: '/kb/principles',
      args: { query: 'contract', top_k: 5 },
    },
    {
      method: 'kbRead',
      invoke: (client: BackendClient) => client.kbRead({ note: 'cli-kb-tooling' }),
      path: '/kb/read',
      args: { note: 'cli-kb-tooling' },
    },
    {
      method: 'kbPromote',
      invoke: (client: BackendClient) =>
        client.kbPromote({
          memo: 'memo/example.md',
          title: 'KB note',
          content: 'Promoted content',
          domain: 'cli',
          topic: 'kb-tooling',
        }),
      path: '/kb/promote',
      args: {
        memo: 'memo/example.md',
        title: 'KB note',
        content: 'Promoted content',
        domain: 'cli',
        topic: 'kb-tooling',
      },
    },
    {
      method: 'kbUpdate',
      invoke: (client: BackendClient) =>
        client.kbUpdate({
          note: 'cli-kb-tooling',
          content: 'Updated content',
        }),
      path: '/kb/update',
      args: {
        note: 'cli-kb-tooling',
        content: 'Updated content',
      },
    },
    {
      method: 'kbDelete',
      invoke: (client: BackendClient) => client.kbDelete({ note: 'cli-kb-tooling' }),
      path: '/kb/delete',
      args: { note: 'cli-kb-tooling' },
    },
    {
      method: 'kbSourceImport',
      invoke: (client: BackendClient) =>
        client.kbSourceImport({
          slug: 'bridge-removal-plan',
          stagedPath: '/tmp/bridge-removal-plan.md',
          meta: {
            title: 'Bridge Removal Plan',
            type: 'markdown',
            tags: ['plan', 'bridge'],
            importedAt: '2026-04-07T00:00:00.000Z',
          },
        }),
      path: '/kb/source-import',
      args: {
        slug: 'bridge-removal-plan',
        stagedPath: '/tmp/bridge-removal-plan.md',
        meta: {
          title: 'Bridge Removal Plan',
          type: 'markdown',
          tags: ['plan', 'bridge'],
          importedAt: '2026-04-07T00:00:00.000Z',
        },
      },
    },
    {
      method: 'kbSourceList',
      invoke: (client: BackendClient) => client.kbSourceList(),
      path: '/kb/source-list',
      args: {},
    },
    {
      method: 'kbSourceDelete',
      invoke: (client: BackendClient) => client.kbSourceDelete({ slug: 'bridge-removal-plan' }),
      path: '/kb/source-delete',
      args: { slug: 'bridge-removal-plan' },
    },
    {
      method: 'kbMemo',
      invoke: (client: BackendClient) =>
        client.kbMemo({ topic: 'kb-routing', content: 'Memo body', owner: 'test-session' }),
      path: '/kb/memo',
      args: { topic: 'kb-routing', content: 'Memo body', owner: 'test-session' },
    },
    {
      method: 'kbMemoList',
      invoke: (client: BackendClient) => client.kbMemoList({}),
      path: '/kb/memo-list',
      args: {},
    },
    {
      method: 'kbMemoDelete',
      invoke: (client: BackendClient) => client.kbMemoDelete({ pattern: '2026*' }),
      path: '/kb/memo-delete',
      args: { pattern: '2026*' },
    },
    {
      method: 'kbMemoPurge',
      invoke: (client: BackendClient) => client.kbMemoPurge({}),
      path: '/kb/memo-purge',
      args: {},
    },
    {
      method: 'kbReindex',
      invoke: (client: BackendClient) => client.kbReindex({}),
      path: '/kb/reindex',
      args: {},
    },
  ])('routes $method through the dedicated KB endpoint', async ({ invoke, path, args }) => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(invoke(client)).resolves.toEqual({ ok: true, data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4100${path}`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          context: defaultContext,
          args,
        }),
      }),
    );
  });

  it.each([
    {
      method: 'providerExec',
      invoke: (client: BackendClient) =>
        client.providerExec('codex', 'hello', { model: 'gpt-5', bypass_permissions: true }),
      path: '/provider/codex',
      args: { op: 'exec', prompt: 'hello', model: 'gpt-5', bypass_permissions: true },
    },
    {
      method: 'providerAgentDispatch',
      invoke: (client: BackendClient) =>
        client.providerAgentDispatch('codex', 'other:agent', 'hello', {
          session: 'session-1',
          work_dir: '/tmp/work',
          model: 'gpt-5',
          owner: 'owner-1',
          bypass_permissions: true,
        }),
      path: '/provider/codex',
      args: {
        op: 'other:agent',
        prompt: 'hello',
        session: 'session-1',
        work_dir: '/tmp/work',
        model: 'gpt-5',
        owner: 'owner-1',
        bypass_permissions: true,
      },
    },
    {
      method: 'resume',
      invoke: (client: BackendClient) => client.resume('session-1', 'continue', { model: 'gpt-5' }),
      path: '/provider/codex',
      args: { op: 'resume', session: 'session-1', prompt: 'continue', model: 'gpt-5' },
    },
    {
      method: 'workflow',
      invoke: (client: BackendClient) =>
        client.workflow('architect', {
          start_prompt: 'start here',
          provider: 'codex',
          work_dir: '/tmp/workflow',
        }),
      path: '/workflow',
      args: {
        expression: 'architect',
        start_prompt: 'start here',
        provider: 'codex',
        work_dir: '/tmp/workflow',
      },
    },
    {
      method: 'abortJobs',
      invoke: (client: BackendClient) => client.abortJobs(['job-1']),
      path: '/abort',
      args: { jobs: ['job-1'] },
    },
  ])('routes $method through the dedicated backend endpoint', async ({ invoke, path, args }) => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(invoke(client)).resolves.toEqual({ ok: true, data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4100${path}`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          context: defaultContext,
          args,
        }),
      }),
    );
  });

  it('returns structured domain errors from parsed dedicated-route failures', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = {
      ok: false,
      code: 'scope_mismatch',
      message: 'Jobs do not belong to this project',
      detail: { jobs: ['job-1'] },
    };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(client.abortJobs(['job-1'])).resolves.toEqual(errorBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/abort',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          context: defaultContext,
          args: { jobs: ['job-1'] },
        }),
      }),
    );
  });

  it('treats structured dedicated-route recovery responses as domain errors', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = {
      ok: false,
      code: 'backend_recovering',
      message: 'recovering — retry after 500ms',
    } as const;

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(client.providerExec('codex', 'hello')).resolves.toEqual(errorBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/provider/codex',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          context: defaultContext,
          args: { op: 'exec', prompt: 'hello' },
        }),
      }),
    );
  });

  it('returns backend_recovering results from discuss routes instead of throwing', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = {
      ok: false,
      code: 'backend_recovering',
      message: 'recovering — retry after 500ms',
    } as const;
    const args = {
      topic: 'Should the bridge be removed?',
      agents: [
        { name: 'alice', persona: 'Architect' },
        { name: 'bob', persona: 'Operator' },
      ],
    };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(client.discussStart(args)).resolves.toEqual(errorBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/discuss/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          context: defaultContext,
          args,
        }),
      }),
    );
  });

  it('returns backend_recovering results from KB routes instead of throwing', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = {
      ok: false,
      code: 'backend_recovering',
      message: 'recovering — retry after 500ms',
    } as const;

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(client.kbSearch({ query: 'accel' })).resolves.toEqual(errorBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/kb/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          context: defaultContext,
          args: { query: 'accel' },
        }),
      }),
    );
  });

  it('reserves BackendToolHttpError for transport and server failures', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = { error: 'backend_shutting_down' };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    let caught: unknown;
    try {
      await client.abortJobs(['job-1']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackendToolHttpError);
    expect((caught as BackendToolHttpError).message).toBe('Backend shutting down, retry');
    expect((caught as BackendToolHttpError).statusCode).toBe(503);
    expect((caught as BackendToolHttpError).body).toEqual(errorBody);
  });
});
