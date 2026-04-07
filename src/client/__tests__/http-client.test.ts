import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { KbSearchResponse } from '../../kb/types.js';
import type { WatchState } from '../../discuss/watch.js';
import type { BackendHandle } from '../backend-lifecycle.js';
import {
  BackendClient,
  BackendToolHttpError,
  type AcceptedLaunchResponse,
  type CallerContext,
  type SessionCreateResponse,
  type WorkflowLaunchResponse,
} from '../http-client.js';
import type {
  AcceptedLaunchResponse as BarrelAcceptedLaunchResponse,
  SessionCreateResponse as BarrelSessionCreateResponse,
  WorkflowLaunchResponse as BarrelWorkflowLaunchResponse,
} from '../index.js';

const backendHandle: BackendHandle = {
  port: 4100,
  host: '127.0.0.1',
  token: 'backend-token',
  instanceId: 'backend-instance',
};

const defaultContext: CallerContext = {
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

  it.each([
    {
      name: 'discussStart',
      invoke: (client: BackendClient) =>
        client.discussStart({
          topic: 'Should the bridge be removed?',
          agents: [{ name: 'alice', persona: 'Architect' }],
        }),
      path: '/discuss/start',
      body: {
        topic: 'Should the bridge be removed?',
        agents: [{ name: 'alice', persona: 'Architect' }],
        projectRoot: '/tmp/project',
        owner: 'team-a',
        effort: 'high',
        claudeModelCap: 'sonnet',
      },
      responseBody: { session: 'discuss-1' },
    },
    {
      name: 'kbSearch',
      invoke: (client: BackendClient) => client.kbSearch({ query: 'accel' }),
      path: '/kb/search',
      body: {
        query: 'accel',
        projectRoot: '/tmp/project',
        owner: 'team-a',
        effort: 'high',
        claudeModelCap: 'sonnet',
      },
      responseBody: { results: [], mode: 'text' },
    },
    {
      name: 'kbMemo',
      invoke: (client: BackendClient) => client.kbMemo({ topic: 'routing', content: 'memo body', owner: 'memo-owner' }),
      path: '/kb/memo',
      body: {
        topic: 'routing',
        content: 'memo body',
        owner: 'memo-owner',
        projectRoot: '/tmp/project',
        effort: 'high',
        claudeModelCap: 'sonnet',
      },
      responseBody: { filename: '20260408-routing.md', path: '/tmp/project/.coral/memos/20260408-routing.md' },
    },
  ])('posts direct discuss/KB bodies for $name and returns the unwrapped success payload', async ({ invoke, path, body, responseBody }) => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(responseBody));

    await expect(invoke(client)).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:4100${path}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  });

  it('uses the new job and session read routes', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });
    const sessionsBody = {
      sessions: [{ sessionId: 'session-1', provider: 'codex', provenanceState: 'authoritative' as const }],
    };
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
            launch: {
              state: 'ready' as const,
              updatedAt: '2026-04-08T00:00:00.000Z',
            },
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
          eventId: 1,
          type: 'progress' as const,
          ts: '2026-04-08T00:00:00.000Z',
          message: 'working',
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(jsonResponse(sessionsBody))
      .mockResolvedValueOnce(jsonResponse(jobsBody))
      .mockResolvedValueOnce(jsonResponse(detailBody));

    await expect(client.listSessions()).resolves.toEqual(sessionsBody);
    await expect(client.listJobs('running')).resolves.toEqual(jobsBody);
    await expect(client.getJob('job-1')).resolves.toEqual(detailBody);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4100/sessions',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4100/api/jobs?phase=running',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:4100/api/jobs/job-1',
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
          'data: {"type":"progress","jobId":"job-1","sessionId":"session-1","eventId":1,"message":"working"}',
          '',
          'event: timeout',
          'data: {"type":"timeout","runningJobIds":["job-1"]}',
          '',
        ].join('\n'),
      ),
    );

    const stream = await client.waitJobs(['job-1'], {
      timeoutSeconds: 5,
      cursor: { jobs: { 'job-1': 3 } },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const done = await reader.read();

    expect(first.value).toEqual({
      type: 'progress',
      jobId: 'job-1',
      sessionId: 'session-1',
      eventId: 1,
      message: 'working',
    });
    expect(second.value).toEqual({
      type: 'timeout',
      runningJobIds: ['job-1'],
    });
    expect(done.done).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/jobs/wait',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          jobIds: ['job-1'],
          timeoutSeconds: 5,
          cursor: { jobs: { 'job-1': 3 } },
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

  it('exports accepted-launch types through the public client barrel and returns typed direct payloads', () => {
    expectTypeOf<AcceptedLaunchResponse>().toEqualTypeOf<BarrelAcceptedLaunchResponse>();
    expectTypeOf<SessionCreateResponse>().toEqualTypeOf<BarrelSessionCreateResponse>();
    expectTypeOf<WorkflowLaunchResponse>().toEqualTypeOf<BarrelWorkflowLaunchResponse>();
    expectTypeOf<ReturnType<BackendClient['createSession']>>().toEqualTypeOf<Promise<SessionCreateResponse>>();
    expectTypeOf<ReturnType<BackendClient['workflow']>>().toEqualTypeOf<Promise<WorkflowLaunchResponse>>();
    expectTypeOf<ReturnType<BackendClient['discussWatch']>>().toEqualTypeOf<Promise<WatchState>>();
    expectTypeOf<ReturnType<BackendClient['kbSearch']>>().toEqualTypeOf<Promise<KbSearchResponse>>();
  });

  it('still reserves BackendToolHttpError for transport and server failures', async () => {
    const client = new BackendClient({
      ensureBackend: async () => backendHandle,
      defaultContext,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'backend_shutting_down' }, 503, 'Service Unavailable'));

    let caught: unknown;
    try {
      await client.abortJobs(['job-1']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackendToolHttpError);
    expect((caught as BackendToolHttpError).message).toBe('Backend shutting down, retry');
    expect((caught as BackendToolHttpError).statusCode).toBe(503);
    expect((caught as BackendToolHttpError).body).toEqual({ error: 'backend_shutting_down' });
  });
});
