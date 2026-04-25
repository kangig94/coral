import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendHandle } from '#src/transport/http/backend-handle.js';
import {
  BackendClient,
  BackendToolHttpError,
  type InvocationContext,
  type SessionCreateResponse,
  type WorkflowLaunchResponse,
} from '#src/transport/http/client.js';

const backendHandle: BackendHandle = {
  port: 4100,
  host: '127.0.0.1',
  token: 'backend-token',
  instanceId: 'backend-instance',
};

const defaultContext: InvocationContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
  coralEnv: {
    CORAL_OWNER: 'team-a',
    CORAL_EFFORT: 'high',
    CORAL_CLAUDE_MODEL_CAP: 'sonnet',
    CORAL_TEST_IGNORED: 'not-forwarded',
  },
};

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('transport/http http-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('routes createSession through POST /sessions with a direct body and normalized controller fields', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const responseBody: SessionCreateResponse = {
      session: 'session-1',
      job: 'job-1',
      launchState: 'running',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody, 201, 'Created'));

    await expect(
      client.createSession('codex', 'hello', {
        model: 'gpt-5',
        agent: 'architect',
        workDir: '/tmp/work',
        bypassPermissions: true,
        systemPrompt: 'system',
      }),
    ).resolves.toEqual(responseBody);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': 'backend-token',
        },
        body: JSON.stringify({
          provider: 'codex',
          prompt: 'hello',
          model: 'gpt-5',
          agent: 'architect',
          workDir: '/tmp/work',
          bypassPermissions: true,
          systemPrompt: 'system',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('routes sendMessage and forkSession through the new session resource endpoints', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            session: 'session-1',
            job: 'job-2',
            launchState: 'queued',
          },
          202,
          'Accepted',
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            session: 'session-2',
            job: 'job-3',
            launchState: 'running',
          },
          201,
          'Created',
        ),
      );

    await expect(
      client.sendMessage('session-1', 'continue', {
        model: 'gpt-5',
        workDir: '/tmp/work',
        bypassPermissions: false,
        systemPrompt: 'continue-system',
      }),
    ).resolves.toEqual({
      session: 'session-1',
      job: 'job-2',
      launchState: 'queued',
    });
    await expect(client.forkSession('session-1')).resolves.toEqual({
      session: 'session-2',
      job: 'job-3',
      launchState: 'running',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4100/sessions/session-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'continue',
          model: 'gpt-5',
          workDir: '/tmp/work',
          bypassPermissions: false,
          systemPrompt: 'continue-system',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4100/sessions/session-1/forks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('includes provider in sendMessage requests when provided', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          session: 'session-1',
          job: 'job-4',
          launchState: 'queued',
        },
        202,
        'Accepted',
      ),
    );

    await expect(
      client.sendMessage('session-1', 'continue', {
        provider: 'codex',
        model: 'gpt-5',
      }),
    ).resolves.toEqual({
      session: 'session-1',
      job: 'job-4',
      launchState: 'queued',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/sessions/session-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'continue',
          provider: 'codex',
          model: 'gpt-5',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('omits provider from sendMessage requests when not provided', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          session: 'session-1',
          job: 'job-5',
          launchState: 'queued',
        },
        202,
        'Accepted',
      ),
    );

    await expect(
      client.sendMessage('session-1', 'continue', {
        model: 'gpt-5',
      }),
    ).resolves.toEqual({
      session: 'session-1',
      job: 'job-5',
      launchState: 'queued',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/sessions/session-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'continue',
          model: 'gpt-5',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('includes provider in forkSession requests when provided', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          session: 'session-2',
          job: 'job-6',
          launchState: 'running',
        },
        201,
        'Created',
      ),
    );

    await expect(
      client.forkSession('session-1', 'branch', {
        provider: 'claude',
        model: 'sonnet',
      }),
    ).resolves.toEqual({
      session: 'session-2',
      job: 'job-6',
      launchState: 'running',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/sessions/session-1/forks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'branch',
          provider: 'claude',
          model: 'sonnet',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('routes workflow through POST /workflow with the camelCase request shape', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const responseBody: WorkflowLaunchResponse = {
      session: 'workflow-session',
      job: 'workflow-job',
      launchState: 'queued',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody, 202, 'Accepted'));

    await expect(
      client.workflow('architect', {
        startPrompt: 'start here',
        context: 'shared context',
        provider: 'codex',
        workDir: '/tmp/workflow',
        owner: 'override-owner',
        claudeModelCap: 'haiku',
      }),
    ).resolves.toEqual(responseBody);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/workflow',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          expression: 'architect',
          startPrompt: 'start here',
          context: 'shared context',
          provider: 'codex',
          workDir: '/tmp/workflow',
          owner: 'override-owner',
          claudeModelCap: 'haiku',
          projectRoot: '/tmp/project',
          effort: 'high',
        }),
      }),
    );
  });

  it('routes discuss resource methods through the new endpoints and verbs', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    const seedArgs = {
      controversy_axes: [{ axis: 'cost', positions: ['low', 'high'] }],
      n: 3,
      seed: 42,
    };
    const startArgs = {
      topic: 'Should the bridge be removed?',
      agents: [{ name: 'alice', persona: 'Architect' }],
    };
    const bidArgs = {
      session: 'discuss-1',
      agent_name: 'alice',
      score: 80,
      thought: 'Ship it.',
    };
    const speechArgs = {
      session: 'discuss-1',
      agent_name: 'alice',
      content: 'Ship it.',
    };
    const seedBody = { personas: [{ name: 'Avery' }] };
    const startBody = { session: 'discuss-1' };
    const watchBody = { state: { status: 'running' } };
    const bidBody = { ok: true, queued: false };
    const speechBody = { ok: true };
    const abortBody = { ok: true, session: 'discuss-1' };
    const sessionsBody = { sessions: [{ sessionId: 'discuss-1', authority: 'live' }] };
    const detailBody = { authority: 'persisted', view: 'audit', session: { sessionId: 'discuss-1' }, transcript: [] };

    fetchMock
      .mockResolvedValueOnce(jsonResponse(seedBody))
      .mockResolvedValueOnce(jsonResponse(startBody, 201, 'Created'))
      .mockResolvedValueOnce(jsonResponse(watchBody))
      .mockResolvedValueOnce(jsonResponse(bidBody))
      .mockResolvedValueOnce(jsonResponse(speechBody))
      .mockResolvedValueOnce(jsonResponse(abortBody))
      .mockResolvedValueOnce(jsonResponse(sessionsBody))
      .mockResolvedValueOnce(jsonResponse(detailBody));

    await expect(client.discussSeed(seedArgs)).resolves.toEqual(seedBody);
    await expect(client.discussStart(startArgs)).resolves.toEqual(startBody);
    await expect(client.discussWatch('discuss-1', 3)).resolves.toEqual(watchBody);
    await expect(client.discussBid(bidArgs)).resolves.toEqual(bidBody);
    await expect(client.discussSpeech(speechArgs)).resolves.toEqual(speechBody);
    await expect(client.discussAbort('discuss-1')).resolves.toEqual(abortBody);
    await expect(client.listDiscussSessions()).resolves.toEqual(sessionsBody);
    await expect(client.getDiscussSession('discuss-1', 'audit')).resolves.toEqual(detailBody);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4100/discuss/persona-sets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(seedArgs),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4100/discuss/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ...startArgs,
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4100/discuss/sessions/discuss-1/events?projectRoot=%2Ftmp%2Fproject&cursor=3',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4100/discuss/sessions/discuss-1/bids',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          agent_name: 'alice',
          score: 80,
          thought: 'Ship it.',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'http://127.0.0.1:4100/discuss/sessions/discuss-1/speeches',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          agent_name: 'alice',
          content: 'Ship it.',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'http://127.0.0.1:4100/discuss/sessions/discuss-1?projectRoot=%2Ftmp%2Fproject',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      'http://127.0.0.1:4100/discuss/sessions',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      8,
      'http://127.0.0.1:4100/discuss/sessions/discuss-1?projectRoot=%2Ftmp%2Fproject&view=audit',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
  });

  it('routes KB resource methods through the new endpoints and verbs', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ path: '/tmp/project/notes/contracts-overview.md' }, 201, 'Created'))
      .mockResolvedValueOnce(jsonResponse({ path: '/tmp/project/notes/contracts-overview.md' }))
      .mockResolvedValueOnce(jsonResponse({ deleted: 'contracts/overview' }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            status: 'completed',
            job: 'kb-import-job',
            readiness: 'base-search',
            slug: 'bridge-removal-plan',
            path: '/tmp/project/sources/bridge.md',
          },
          201,
          'Created',
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ deleted: 'bridge-removal-plan' }))
      .mockResolvedValueOnce(
        jsonResponse({ filename: '20260408-routing.md', path: '/tmp/project/.coral/memos/20260408-routing.md' }, 201, 'Created'),
      )
      .mockResolvedValueOnce(jsonResponse({ notes: 1, sources: 2, communities: 3, principles: 4, duration_ms: 10, mode: 'text' }));

    await expect(
      client.kbPromote({
        memo: '20260408-routing',
        title: 'Contracts Overview',
        content: 'Body',
        domain: 'eng',
        topic: 'routing',
      }),
    ).resolves.toEqual({ path: '/tmp/project/notes/contracts-overview.md' });
    await expect(client.kbUpdate({ note: 'contracts/overview', title: 'Updated' })).resolves.toEqual({
      path: '/tmp/project/notes/contracts-overview.md',
    });
    await expect(client.kbDelete({ note: 'contracts/overview' })).resolves.toEqual({
      deleted: 'contracts/overview',
    });
    await expect(
      client.kbSourceImport({
        filePath: '/tmp/source.pdf',
        slug: 'bridge-removal-plan',
        readiness: 'base-search',
      }),
    ).resolves.toEqual({
      status: 'completed',
      job: 'kb-import-job',
      readiness: 'base-search',
      slug: 'bridge-removal-plan',
      path: '/tmp/project/sources/bridge.md',
    });
    await expect(client.kbSourceDelete({ slug: 'bridge-removal-plan' })).resolves.toEqual({
      deleted: 'bridge-removal-plan',
    });
    await expect(client.kbMemo({ topic: 'routing', content: 'memo body', owner: 'memo-owner' })).resolves.toEqual({
      filename: '20260408-routing.md',
      path: '/tmp/project/.coral/memos/20260408-routing.md',
    });
    await expect(client.kbReindex({})).resolves.toEqual({
      notes: 1,
      sources: 2,
      communities: 3,
      principles: 4,
      duration_ms: 10,
      mode: 'text',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4100/kb/notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          memo: '20260408-routing',
          title: 'Contracts Overview',
          content: 'Body',
          domain: 'eng',
          topic: 'routing',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4100/kb/notes/contracts%2Foverview',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          title: 'Updated',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4100/kb/notes/contracts%2Foverview',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4100/kb/sources',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          filePath: '/tmp/source.pdf',
          slug: 'bridge-removal-plan',
          readiness: 'base-search',
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'http://127.0.0.1:4100/kb/sources/bridge-removal-plan',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'http://127.0.0.1:4100/kb/memos',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          topic: 'routing',
          content: 'memo body',
          owner: 'memo-owner',
          projectRoot: '/tmp/project',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      'http://127.0.0.1:4100/kb/index',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('routes KB GET and DELETE resource methods with query params and owner fallback', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ results: [], mode: 'text' }))
      .mockResolvedValueOnce(jsonResponse({ sources: [{ slug: 'bridge-removal-plan' }] }))
      .mockResolvedValueOnce(jsonResponse({ principles: ['contract-first-design'], total: 1 }))
      .mockResolvedValueOnce(jsonResponse({ memos: [{ filename: '20260408-routing.md', summary: 'routing', createdAt: '2026-04-08T00:00:00.000Z' }] }))
      .mockResolvedValueOnce(jsonResponse({ deleted: ['20260408-routing.md'], count: 1 }))
      .mockResolvedValueOnce(jsonResponse({ deleted: 5 }));

    await expect(client.kbSearch({ query: 'contracts', scope: 'notes', top_k: 5 })).resolves.toEqual({
      results: [],
      mode: 'text',
    });
    await expect(client.kbSourceList()).resolves.toEqual({
      sources: [{ slug: 'bridge-removal-plan' }],
    });
    await expect(client.kbPrinciples({ query: 'contract', top_k: 5, verbose: true })).resolves.toEqual({
      principles: ['contract-first-design'],
      total: 1,
    });
    await expect(client.kbMemoList({})).resolves.toEqual({
      memos: [{ filename: '20260408-routing.md', summary: 'routing', createdAt: '2026-04-08T00:00:00.000Z' }],
    });
    await expect(client.kbMemoDelete({ pattern: '*routing*' })).resolves.toEqual({
      deleted: ['20260408-routing.md'],
      count: 1,
    });
    await expect(client.kbMemoPurge({ owner: 'override-owner' })).resolves.toEqual({
      deleted: 5,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4100/kb/entries?q=contracts&scope=notes&top_k=5',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4100/kb/sources',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4100/kb/principles?q=contract&top_k=5&verbose=true',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:4100/kb/memos?projectRoot=%2Ftmp%2Fproject&owner=team-a',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'http://127.0.0.1:4100/kb/memos?projectRoot=%2Ftmp%2Fproject&pattern=*routing*&owner=team-a',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'http://127.0.0.1:4100/kb/memos?projectRoot=%2Ftmp%2Fproject&all=true&owner=override-owner',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
  });

  it('dispatches kbRead explicit selectors directly to the matching resource route', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
    });
    const responseBody = {
      kind: 'source',
      note: 'bridge-removal-plan',
      title: 'Bridge Removal Plan',
      content: 'Source body.',
      tags: ['plan'],
      principles: [],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody));

    await expect(client.kbRead({ note: 'sources:bridge-removal-plan' })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/kb/sources/bridge-removal-plan',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
  });

  it('preserves memo precedence for timestamp-shaped bare kbRead slugs', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const slug = '20260323-010203-shared-slug';
    const responseBody = {
      kind: 'memo',
      note: slug,
      title: slug,
      content: 'Memo body.',
      tags: [],
      principles: [],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody));

    await expect(client.kbRead({ note: slug })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4100/kb/memos/${slug}?projectRoot=%2Ftmp%2Fproject`,
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
  });

  it('falls through kbRead bare probes only on 404 responses', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const responseBody = {
      kind: 'source',
      note: 'bridge-removal-plan',
      title: 'Bridge Removal Plan',
      content: 'Source body.',
      tags: ['plan'],
      principles: [],
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 'not_found', message: 'missing note' }, 404, 'Not Found'))
      .mockResolvedValueOnce(jsonResponse({ code: 'not_found', message: 'missing community' }, 404, 'Not Found'))
      .mockResolvedValueOnce(jsonResponse(responseBody));

    await expect(client.kbRead({ note: 'bridge-removal-plan' })).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4100/kb/notes/bridge-removal-plan',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4100/kb/communities/bridge-removal-plan',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4100/kb/sources/bridge-removal-plan',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('surfaces non-404 kbRead probe failures immediately', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'kb_unavailable', message: 'Knowledge base is not available.' }, 503, 'Service Unavailable'),
    );

    await expect(client.kbRead({ note: 'bridge-removal-plan' })).rejects.toMatchObject({
      name: 'BackendToolHttpError',
      statusCode: 503,
      body: { code: 'kb_unavailable', message: 'Knowledge base is not available.' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: 'discussWatch',
      invoke: (client: BackendClient) => client.discussWatch('discuss-1'),
    },
    {
      name: 'discussAbort',
      invoke: (client: BackendClient) => client.discussAbort('discuss-1'),
    },
    {
      name: 'getDiscussSession',
      invoke: (client: BackendClient) => client.getDiscussSession('discuss-1'),
    },
    {
      name: 'kbMemoList',
      invoke: (client: BackendClient) => client.kbMemoList({}),
    },
    {
      name: 'kbMemoDelete',
      invoke: (client: BackendClient) => client.kbMemoDelete({ pattern: '*' }),
    },
    {
      name: 'kbMemoPurge',
      invoke: (client: BackendClient) => client.kbMemoPurge({}),
    },
    {
      name: 'kbRead bare',
      invoke: (client: BackendClient) => client.kbRead({ note: 'bridge-removal-plan' }),
    },
  ])('requires InvocationContext for scoped route handling in $name', async ({ invoke }) => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
    });

    await expect(invoke(client)).rejects.toThrow(/InvocationContext is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the new job read routes', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const jobsBody = {
      jobs: [
        {
          jobId: 'job-1',
          status: {
            jobId: 'job-1',
            sessionId: 'session-1',
            provider: 'codex',
            projectRoot: '/tmp/project',
            backendNamespace: 'test',
            phase: 'running' as const,
            updatedAt: '2026-04-08T00:00:00.000Z',
          },
        },
      ],
    };
    const detailBody = {
      status: jobsBody.jobs[0].status,
      events: [
        {
          jobId: 'job-1',
          sessionId: 'session-1',
          seq: 1,
          type: 'progress' as const,
          ts: '2026-04-08T00:00:00.000Z',
          message: 'working',
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse(jobsBody))
      .mockResolvedValueOnce(jsonResponse(detailBody));

    await expect(client.listJobs({ phase: 'running' })).resolves.toEqual(jobsBody);
    await expect(client.getJob('job-1')).resolves.toEqual(detailBody);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4100/jobs?projectRoot=%2Ftmp%2Fproject&phase=running',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4100/jobs/job-1',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
  });

  it('posts abortJobs to /jobs/abort and returns AbortResult directly', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ aborted: ['job-1'], notFound: ['job-2'] }));

    await expect(client.abortJobs(['job-1', 'job-2'])).resolves.toEqual({
      aborted: ['job-1'],
      notFound: ['job-2'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/jobs/abort',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          jobs: ['job-1', 'job-2'],
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('posts waitJobs to /jobs/wait and parses SSE events into a typed stream', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      sseResponse(
        [
          'event: progress',
          'data: {"type":"progress","jobId":"job-1","seq":4,"message":"working"}',
          '',
          'event: waiting',
          'data: {"type":"waiting","waitingJobIds":["job-1"]}',
          '',
        ].join('\n'),
      ),
    );

    const stream = await client.waitJobs(['job-1'], {
      timeoutSeconds: 5,
      cursor: { afterSeq: 3 },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const done = await reader.read();

    expect(first.value).toEqual({
      type: 'progress',
      jobId: 'job-1',
      seq: 4,
      message: 'working',
    });
    expect(second.value).toEqual({
      type: 'waiting',
      waitingJobIds: ['job-1'],
    });
    expect(done.done).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/jobs/wait',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          jobIds: ['job-1'],
          timeoutSeconds: 5,
          cursor: { afterSeq: 3 },
          projectRoot: '/tmp/project',
          owner: 'team-a',
          effort: 'high',
          claudeModelCap: 'sonnet',
        }),
      }),
    );
  });

  it('throws BackendToolHttpError for non-2xx responses instead of returning success-path domain errors', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const errorBody = {
      code: 'backend_recovering',
      message: 'recovering - retry later',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(errorBody, 503, 'Service Unavailable'));

    await expect(client.createSession('codex', 'hello')).rejects.toMatchObject({
      name: 'BackendToolHttpError',
      message: 'recovering - retry later',
      statusCode: 503,
      body: errorBody,
    });
  });

  it('still reserves BackendToolHttpError for transport and server failures', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'backend_shutting_down', message: 'Backend shutting down' }, 503, 'Service Unavailable'),
    );

    let caught: unknown;
    try {
      await client.abortJobs(['job-1']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackendToolHttpError);
    expect((caught as BackendToolHttpError).message).toBe('Backend shutting down');
    expect((caught as BackendToolHttpError).statusCode).toBe(503);
    expect((caught as BackendToolHttpError).body).toEqual({
      code: 'backend_shutting_down',
      message: 'Backend shutting down',
    });
  });
});
