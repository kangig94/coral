import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpResult } from '../../shared/mcp-utils.js';

type RegisteredHandler = (...args: unknown[]) => Promise<unknown>;

type CallToolHandler = (
  request: {
    params: {
      name: string;
      arguments: Record<string, unknown>;
    };
  },
  extra: {
    signal: AbortSignal;
    _meta: Record<string, unknown>;
    sendNotification?: (notification: unknown) => Promise<void>;
  },
) => Promise<McpResult>;

const mockState = vi.hoisted(() => ({
  handlers: new Map<unknown, RegisteredHandler>(),
  ensureBackend: vi.fn(),
  proxyToolCall: vi.fn(),
  streamWait: vi.fn(),
  handleBackendToolCall: vi.fn(),
  buildToolList: vi.fn((tools: unknown) => tools ?? []),
  readFileSync: vi.fn(),
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    setRequestHandler(schema: unknown, handler: RegisteredHandler) {
      mockState.handlers.set(schema, handler);
    }

    connect = mockState.connect;
    close = mockState.close;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));

vi.mock('node:fs', () => ({
  readFileSync: mockState.readFileSync,
}));

vi.mock('../backend-client.js', () => ({
  ensureBackend: mockState.ensureBackend,
  proxyToolCall: mockState.proxyToolCall,
  streamWait: mockState.streamWait,
}));

vi.mock('../backend-tool.js', () => ({
  buildToolList: mockState.buildToolList,
  handleBackendToolCall: mockState.handleBackendToolCall,
}));

async function* emit(events: readonly unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
  }
}

async function* fail(error: unknown): AsyncGenerator<never> {
  throw error;
}

async function loadCallToolHandler(): Promise<CallToolHandler> {
  vi.resetModules();
  mockState.handlers.clear();
  await import('../server.js');
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const handler = mockState.handlers.get(CallToolRequestSchema) as CallToolHandler | undefined;
  if (!handler) {
    throw new Error('CallTool handler was not registered');
  }
  return handler;
}

async function invokeToolRaw(
  name: string,
  argumentsValue: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<McpResult> {
  const handler = await loadCallToolHandler();
  return handler(
    {
      params: {
        name,
        arguments: argumentsValue,
      },
    },
    {
      signal: options?.signal ?? new AbortController().signal,
      _meta: {},
    },
  );
}

async function invokeWaitRaw(argumentsValue: Record<string, unknown>) {
  return invokeToolRaw('wait', argumentsValue);
}

async function invokeWait(argumentsValue: Record<string, unknown>) {
  const result = await invokeWaitRaw(argumentsValue);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('bridge wait handler', () => {
  beforeEach(() => {
    mockState.ensureBackend.mockReset();
    mockState.proxyToolCall.mockReset();
    mockState.streamWait.mockReset();
    mockState.handleBackendToolCall.mockReset();
    mockState.buildToolList.mockClear();
    mockState.readFileSync.mockReset();
    mockState.connect.mockClear();
    mockState.close.mockClear();
    mockState.ensureBackend.mockResolvedValue({ port: 4100, token: 'backend-token' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockState.handlers.clear();
  });

  it('workflow wait responses return metadata plus content shaped by inline mode', async () => {
    mockState.streamWait
      .mockImplementationOnce(() => emit([
        {
          type: 'terminal',
          completedJobId: 'workflow-success',
          sessionId: 'session-1',
          remainingJobIds: [],
          resultPath: '/tmp/coral-jobs/workflow-success/result.md',
          result: {
            content: 'FINAL',
            workflow: {
              steps: [
                {
                  agent: 'architect',
                  step: 1,
                  atom: 1,
                  provider: 'codex',
                  start: 3,
                  end: 3,
                },
              ],
            },
          },
        },
      ]))
      .mockImplementationOnce(() => emit([
        {
          type: 'terminal',
          completedJobId: 'workflow-failure',
          sessionId: 'session-2',
          remainingJobIds: [],
          resultPath: '/tmp/coral-jobs/workflow-failure/result.md',
          result: {
            content: '',
            notice: 'failed',
            workflow: { steps: [] },
          },
        },
      ]))
      .mockImplementationOnce(() => emit([
        {
          type: 'terminal',
          completedJobId: 'workflow-abort',
          sessionId: 'session-3',
          remainingJobIds: [],
          resultPath: '/tmp/coral-jobs/workflow-abort/result.md',
          result: {
            content: '',
            aborted: true,
            notice: 'aborted',
            workflow: { steps: [] },
          },
        },
      ]));
    mockState.readFileSync
      .mockReturnValueOnce('# Step 1.1: architect\n\nARCH\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('');

    const success = await invokeWait({
      jobs: ['workflow-success'],
      inline: true,
    });
    const failure = await invokeWait({
      jobs: ['workflow-failure'],
      inline: false,
    });
    const aborted = await invokeWait({
      jobs: ['workflow-abort'],
      inline: true,
    });

    expect(success).toEqual({
      state: 'ended',
      completedJobId: 'workflow-success',
      sessionId: 'session-1',
      remainingJobIds: [],
      result: {
        workflow: {
          steps: [
            {
              agent: 'architect',
              step: 1,
              atom: 1,
              provider: 'codex',
              start: 3,
              end: 3,
            },
          ],
        },
        content: '# Step 1.1: architect\n\nARCH\n',
      },
    });
    expect(failure).toEqual({
      state: 'ended',
      completedJobId: 'workflow-failure',
      sessionId: 'session-2',
      remainingJobIds: [],
      result: {
        notice: 'failed',
        workflow: { steps: [] },
        content: '/tmp/coral-jobs/workflow-failure/result.md',
      },
    });
    expect(aborted).toEqual({
      state: 'ended',
      completedJobId: 'workflow-abort',
      sessionId: 'session-3',
      remainingJobIds: [],
      result: {
        aborted: true,
        notice: 'aborted',
        workflow: { steps: [] },
        content: '',
      },
    });
  });

  it('workflow inline: true reads from resultPath file, not terminal content', async () => {
    mockState.readFileSync.mockReturnValueOnce('# Step 1.1: architect\n\nFILE CONTENT');
    mockState.streamWait.mockImplementationOnce(() => emit([
      {
        type: 'terminal',
        completedJobId: 'workflow-diverge',
        sessionId: 'session-diverge',
        remainingJobIds: [],
        resultPath: '/tmp/coral-jobs/workflow-diverge/result.md',
        result: {
          content: 'FINAL',
          workflow: {
            steps: [
              {
                agent: 'architect',
                step: 1,
                atom: 1,
                provider: 'codex',
                start: 3,
                end: 3,
              },
            ],
          },
        },
      },
    ]));

    const result = await invokeWait({
      jobs: ['workflow-diverge'],
      inline: true,
    });
    const terminalResult = result.result as Record<string, unknown>;

    expect(result).toMatchObject({
      state: 'ended',
      completedJobId: 'workflow-diverge',
      sessionId: 'session-diverge',
      remainingJobIds: [],
    });
    expect(terminalResult).toMatchObject({
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 1,
            atom: 1,
            provider: 'codex',
            start: 3,
            end: 3,
          },
        ],
      },
    });
    expect(terminalResult.content).toBe('# Step 1.1: architect\n\nFILE CONTENT');
    expect(terminalResult.content).not.toBe('FINAL');
    expect(mockState.readFileSync).toHaveBeenCalledWith('/tmp/coral-jobs/workflow-diverge/result.md', 'utf-8');
  });

  it('returns ordinary wait timeouts in-band with isError false', async () => {
    mockState.streamWait.mockImplementationOnce(() => emit([
      {
        type: 'timeout',
        runningJobIds: ['job-1'],
      },
    ]));

    const result = await invokeWaitRaw({ jobs: ['job-1'] });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({
      state: 'running',
      runningJobIds: ['job-1'],
    });
  });

  it('keeps terminal job failures in-band with isError false', async () => {
    mockState.streamWait.mockImplementationOnce(() => emit([
      {
        type: 'terminal',
        completedJobId: 'job-failed',
        sessionId: 'session-failed',
        remainingJobIds: [],
        resultPath: '/tmp/coral-jobs/job-failed/result.md',
        result: {
          content: 'provider failure output',
          failed: true,
          exitCode: 1,
        },
      },
    ]));

    const result = await invokeWaitRaw({
      jobs: ['job-failed'],
      inline: true,
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({
      state: 'ended',
      completedJobId: 'job-failed',
      sessionId: 'session-failed',
      remainingJobIds: [],
      result: {
        content: 'provider failure output',
        failed: true,
        exitCode: 1,
      },
    });
  });

  it('returns invalid job ids as mcp errors on backend 404', async () => {
    mockState.streamWait.mockImplementationOnce(() => fail(new Error('Backend request failed: 404 Not Found')));

    const result = await invokeWaitRaw({ jobs: ['missing-job'] });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'jobs_not_found',
      message: 'Requested jobs were not found',
    });
  });

  it('returns scope mismatches as mcp errors on backend 403', async () => {
    mockState.streamWait.mockImplementationOnce(() => fail(new Error('Backend request failed: 403 Forbidden')));

    const result = await invokeWaitRaw({ jobs: ['foreign-job'] });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'scope_mismatch',
      message: 'Requested jobs are outside the current project scope',
    });
  });

  it('returns wait transport failures as mcp errors', async () => {
    mockState.streamWait.mockImplementationOnce(() => fail(new Error('Invalid terminal wait stream event')));

    const result = await invokeWaitRaw({ jobs: ['job-1'] });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'wait_transport_failure',
      message: 'Invalid terminal wait stream event',
    });
  });

  it('should reject legacy include_result parameter', async () => {
    const result = await invokeWaitRaw({ jobs: ['job-1'], include_result: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('include_result');
  });

  it('single-job wait behavior still respects inline', async () => {
    mockState.streamWait
      .mockImplementationOnce(() => emit([
        {
          type: 'terminal',
          completedJobId: 'single-inline',
          sessionId: 'session-a',
          remainingJobIds: [],
          resultPath: '/tmp/coral-jobs/single-inline/result.md',
          result: {
            content: 'INLINE RESULT',
            durationMs: 42,
          },
        },
      ]))
      .mockImplementationOnce(() => emit([
        {
          type: 'terminal',
          completedJobId: 'single-path',
          sessionId: 'session-b',
          remainingJobIds: [],
          resultPath: '/tmp/coral-jobs/single-path/result.md',
          result: {
            content: 'FILE RESULT',
            durationMs: 21,
          },
        },
      ]));

    const inline = await invokeWait({
      jobs: ['single-inline'],
      inline: true,
    });
    const pathOnly = await invokeWait({
      jobs: ['single-path'],
      inline: false,
    });

    expect(inline).toEqual({
      state: 'ended',
      completedJobId: 'single-inline',
      sessionId: 'session-a',
      remainingJobIds: [],
      result: {
        content: 'INLINE RESULT',
        durationMs: 42,
      },
    });
    expect(pathOnly).toEqual({
      state: 'ended',
      completedJobId: 'single-path',
      sessionId: 'session-b',
      remainingJobIds: [],
      result: {
        durationMs: 21,
        content: '/tmp/coral-jobs/single-path/result.md',
      },
    });
  });

  it('passes process.cwd() into streamWait as projectRoot', async () => {
    mockState.streamWait.mockImplementationOnce(() => emit([
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: '/tmp/coral-jobs/job-1/result.md',
        result: { content: 'done' },
      },
    ]));

    await invokeWait({ jobs: ['job-1'] });

    expect(mockState.streamWait).toHaveBeenCalledTimes(1);
    expect(mockState.streamWait.mock.calls[0]?.[5]).toBe(process.cwd());
  });

  it('passes process.cwd() into proxyToolCall as projectRoot', async () => {
    mockState.proxyToolCall.mockResolvedValueOnce({
      status: 'running',
      job: 'job-1',
      session: 'session-1',
    });

    await invokeToolRaw('codex', { op: 'exec', prompt: 'hello' });

    expect(mockState.proxyToolCall).toHaveBeenCalledWith(
      'codex',
      { op: 'exec', prompt: 'hello' },
      expect.objectContaining({ projectRoot: process.cwd() }),
    );
  });

  it('retries on transient SSE failure and succeeds on reconnect', async () => {
    mockState.streamWait
      .mockImplementationOnce(() => fail(new TypeError('terminated')))
      .mockImplementationOnce(() => emit([
        {
          type: 'terminal',
          completedJobId: 'job-1',
          sessionId: 'session-1',
          remainingJobIds: [],
          resultPath: '/tmp/coral-jobs/job-1/result.md',
          result: { content: 'done' },
        },
      ]));

    const result = await invokeWait({ jobs: ['job-1'], inline: true });

    expect(result).toEqual({
      state: 'ended',
      completedJobId: 'job-1',
      sessionId: 'session-1',
      remainingJobIds: [],
      result: { content: 'done' },
    });
    expect(mockState.ensureBackend).toHaveBeenCalledTimes(2);
    expect(mockState.streamWait).toHaveBeenCalledTimes(2);
  });

  it('surfaces error after retries exhausted', async () => {
    mockState.streamWait
      .mockImplementation(() => fail(new TypeError('terminated')));

    const result = await invokeWaitRaw({ jobs: ['job-1'] });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'wait_transport_failure',
      message: 'terminated',
    });
    // 1 initial + 2 retries = 3
    expect(mockState.streamWait).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-transient errors (ensureBackend timeout, HTTP 4xx, parse errors)', async () => {
    // ensureBackend timeout
    mockState.streamWait
      .mockImplementationOnce(() => fail(new Error('Timed out waiting for Coral backend startup')));
    const r1 = await invokeWaitRaw({ jobs: ['job-1'] });
    expect(r1.isError).toBe(true);
    expect(mockState.streamWait).toHaveBeenCalledTimes(1);

    // HTTP 403
    mockState.streamWait.mockReset();
    mockState.streamWait
      .mockImplementationOnce(() => fail(new Error('Backend request failed: 403 Forbidden')));
    const r2 = await invokeWaitRaw({ jobs: ['job-1'] });
    expect(r2.isError).toBe(true);
    expect(JSON.parse(r2.content[0].text).error).toBe('scope_mismatch');
    expect(mockState.streamWait).toHaveBeenCalledTimes(1);

    // Parse error
    mockState.streamWait.mockReset();
    mockState.streamWait
      .mockImplementationOnce(() => fail(new Error('Invalid terminal wait stream event')));
    const r3 = await invokeWaitRaw({ jobs: ['job-1'] });
    expect(r3.isError).toBe(true);
    expect(mockState.streamWait).toHaveBeenCalledTimes(1);
  });

  it('returns graceful running state when signal is aborted (TypeError terminated)', async () => {
    const controller = new AbortController();
    mockState.streamWait.mockImplementationOnce(async function* () {
      controller.abort();
      throw new TypeError('terminated');
    });

    const result = await invokeToolRaw(
      'wait',
      { jobs: ['job-1'] },
      { signal: controller.signal },
    );

    expect(JSON.parse(result.content[0].text)).toEqual({
      state: 'running',
      runningJobIds: ['job-1'],
    });
    expect(result.isError).toBe(false);
  });

  it('passes through backend MCP-shaped tool results unchanged', async () => {
    mockState.proxyToolCall.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ session: 'discuss-1' }) }],
      isError: false,
    });

    const result = await invokeToolRaw('discuss_start', {
      topic: 'topic',
      agents: [
        { name: 'alpha', persona: '# Alpha' },
        { name: 'beta', persona: '# Beta' },
      ],
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ session: 'discuss-1' }) }],
      isError: false,
    });
  });
});
