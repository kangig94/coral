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
      method: 'kbSearch',
      invoke: (client: BackendClient) => client.kbSearch({ query: 'accel' }),
      toolName: 'kb_search',
      args: { query: 'accel' },
    },
    {
      method: 'kbPrinciples',
      invoke: (client: BackendClient) => client.kbPrinciples({ query: 'contract', top_k: 5 }),
      toolName: 'kb_principles',
      args: { query: 'contract', top_k: 5 },
    },
    {
      method: 'kbMemo',
      invoke: (client: BackendClient) =>
        client.kbMemo({ topic: 'kb-routing', content: 'Memo body', owner: 'test-session' }),
      toolName: 'kb_memo',
      args: { topic: 'kb-routing', content: 'Memo body', owner: 'test-session' },
    },
    {
      method: 'kbMemoList',
      invoke: (client: BackendClient) => client.kbMemoList({}),
      toolName: 'kb_memo_list',
      args: {},
    },
    {
      method: 'kbMemoDelete',
      invoke: (client: BackendClient) => client.kbMemoDelete({ pattern: '2026*' }),
      toolName: 'kb_memo_delete',
      args: { pattern: '2026*' },
    },
    {
      method: 'kbMemoPurge',
      invoke: (client: BackendClient) => client.kbMemoPurge({}),
      toolName: 'kb_memo_purge',
      args: {},
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
      toolName: 'kb_promote',
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
      toolName: 'kb_update',
      args: {
        note: 'cli-kb-tooling',
        content: 'Updated content',
      },
    },
    {
      method: 'kbDelete',
      invoke: (client: BackendClient) => client.kbDelete({ note: 'cli-kb-tooling' }),
      toolName: 'kb_delete',
      args: { note: 'cli-kb-tooling' },
    },
    {
      method: 'kbReindex',
      invoke: (client: BackendClient) => client.kbReindex({}),
      toolName: 'kb_reindex',
      args: {},
    },
  ])('routes $method through the matching backend tool', async ({ invoke, toolName, args }) => {
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
      'http://127.0.0.1:4100/tool',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          name: toolName,
          args,
          context: defaultContext,
        }),
      }),
    );
  });

  it.each([
    {
      method: 'providerExec',
      invoke: (client: BackendClient) => client.providerExec('codex', 'hello', { model: 'gpt-5' }),
      path: '/provider/codex',
      args: { op: 'exec', prompt: 'hello', model: 'gpt-5' },
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
    const errorBody = { ok: false, code: 'scope_mismatch', message: 'Jobs do not belong to this project', detail: { jobs: ['job-1'] } };

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
