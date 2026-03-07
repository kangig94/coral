import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  handlers: new Map<unknown, (...args: any[]) => any>(),
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
    setRequestHandler(schema: unknown, handler: (...args: any[]) => any) {
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

async function* emit(events: unknown[]): AsyncGenerator<any> {
  for (const event of events) {
    yield event;
  }
}

async function loadCallToolHandler() {
  vi.resetModules();
  mockState.handlers.clear();
  await import('../server.js');
  const { CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const handler = mockState.handlers.get(CallToolRequestSchema);
  if (!handler) {
    throw new Error('CallTool handler was not registered');
  }
  return handler;
}

async function invokeWaitRaw(argumentsValue: Record<string, unknown>) {
  const handler = await loadCallToolHandler();
  return handler(
    {
      params: {
        name: 'wait',
        arguments: argumentsValue,
      },
    },
    {
      signal: new AbortController().signal,
      _meta: {},
    },
  );
}

async function invokeWait(argumentsValue: Record<string, unknown>) {
  const result = await invokeWaitRaw(argumentsValue);
  return JSON.parse(result.content[0].text) as Record<string, any>;
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
      state: 'completed',
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
      state: 'completed',
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
      state: 'completed',
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

    expect(result).toMatchObject({
      state: 'completed',
      completedJobId: 'workflow-diverge',
      sessionId: 'session-diverge',
      remainingJobIds: [],
    });
    expect(result.result).toMatchObject({
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
    expect(result.result.content).toBe('# Step 1.1: architect\n\nFILE CONTENT');
    expect(result.result.content).not.toBe('FINAL');
    expect(mockState.readFileSync).toHaveBeenCalledWith('/tmp/coral-jobs/workflow-diverge/result.md', 'utf-8');
  });

  it('should reject legacy include_result parameter', async () => {
    const result = await invokeWaitRaw({ jobs: ['job-1'], include_result: true } as any);

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
      state: 'completed',
      completedJobId: 'single-inline',
      sessionId: 'session-a',
      remainingJobIds: [],
      result: {
        content: 'INLINE RESULT',
        durationMs: 42,
      },
    });
    expect(pathOnly).toEqual({
      state: 'completed',
      completedJobId: 'single-path',
      sessionId: 'session-b',
      remainingJobIds: [],
      result: {
        durationMs: 21,
        content: '/tmp/coral-jobs/single-path/result.md',
      },
    });
  });
});
