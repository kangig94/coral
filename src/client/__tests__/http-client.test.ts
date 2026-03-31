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
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(invoke(client)).resolves.toEqual({ ok: true });
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

  it('preserves structured JSON error bodies from /tool failures', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = { error: 'scope_mismatch', jobs: ['job-1'] };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 403,
        statusText: 'Forbidden',
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
    expect((caught as BackendToolHttpError).message).toBe('Backend request failed: 403 Forbidden');
    expect((caught as BackendToolHttpError).statusCode).toBe(403);
    expect((caught as BackendToolHttpError).body).toEqual(errorBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/tool',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          name: 'abort',
          args: { jobs: ['job-1'] },
          context: defaultContext,
        }),
      }),
    );
  });
});
