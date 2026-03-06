import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  handlers: new Map<unknown, (...args: any[]) => any>(),
  ensureBackend: vi.fn(),
  proxyToolCall: vi.fn(),
  streamWait: vi.fn(),
  handleBackendToolCall: vi.fn(),
  buildToolList: vi.fn((tools: unknown) => tools ?? []),
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

async function invokeWait(argumentsValue: Record<string, unknown>) {
  const handler = await loadCallToolHandler();
  const result = await handler(
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

  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('bridge wait handler', () => {
  beforeEach(() => {
    mockState.ensureBackend.mockReset();
    mockState.proxyToolCall.mockReset();
    mockState.streamWait.mockReset();
    mockState.handleBackendToolCall.mockReset();
    mockState.buildToolList.mockClear();
    mockState.connect.mockClear();
    mockState.close.mockClear();
    mockState.ensureBackend.mockResolvedValue({ port: 4100, token: 'backend-token' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockState.handlers.clear();
  });

  it('workflow wait responses always return metadata plus path and never inline content', async () => {
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
                  kind: 'agent',
                  provider: 'codex',
                  tagName: 'architect',
                  headingLine: 1,
                  line: 3,
                  endLine: 3,
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

    const success = await invokeWait({
      jobs: ['workflow-success'],
      include_result: true,
    });
    const failure = await invokeWait({
      jobs: ['workflow-failure'],
      include_result: false,
    });
    const aborted = await invokeWait({
      jobs: ['workflow-abort'],
      include_result: true,
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
              kind: 'agent',
              provider: 'codex',
              tagName: 'architect',
              headingLine: 1,
              line: 3,
              endLine: 3,
            },
          ],
        },
        path: '/tmp/coral-jobs/workflow-success/result.md',
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
        path: '/tmp/coral-jobs/workflow-failure/result.md',
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
        path: '/tmp/coral-jobs/workflow-abort/result.md',
      },
    });
  });

  it('single-job wait behavior still respects include_result', async () => {
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
      include_result: true,
    });
    const pathOnly = await invokeWait({
      jobs: ['single-path'],
      include_result: false,
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
        path: '/tmp/coral-jobs/single-path/result.md',
      },
    });
  });
});
