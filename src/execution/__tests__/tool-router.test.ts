import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LaunchDecision } from '../../shared/types.js';
import type { CallerContext, ToolRequest } from '../request-context.js';
import { routeToolCall, type ExecutionServiceLike, type KbSubsystem } from '../tool-router.js';
import type { ToolDomainResult } from '../tool-response.js';

function createContext(projectRoot: string): CallerContext {
  return {
    projectRoot,
    pluginRoot: projectRoot,
    coralEnv: {},
  };
}

function createExecutionService(overrides: Partial<ExecutionServiceLike> = {}): ExecutionServiceLike {
  const running = { status: 'running', job: 'job-1', session: 'session-1' } satisfies LaunchDecision;
  return {
    start: vi.fn(async () => running),
    resume: vi.fn(async () => running),
    fork: vi.fn(async () => running),
    coralDispatch: vi.fn(async () => running),
    executeWorkflow: vi.fn(async () => running),
    list: vi.fn(() => ({ sessions: [] })),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    waitStream: vi.fn(async function* () {}),
    waitStreamOnce: vi.fn(async () => ({ content: '', nonResumable: false })),
    ...overrides,
  };
}

function createHelpers(service: ExecutionServiceLike) {
  return {
    getExecutionService: () => service,
    getDiscussContext: () => ({}) as never,
    abortJobs: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    scopeCheckJobs: vi.fn((jobIds: string[]) => ({ valid: jobIds, missing: [], mismatch: [] })),
  };
}

function createKbSubsystem(): KbSubsystem {
  return {
    kb: {} as never,
    curateScheduler: {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      schedule: vi.fn(),
      scheduleDeferredCommit: vi.fn(),
      isRunning: () => false,
    },
  };
}

function createRequest(projectRoot: string, name: string, args: Record<string, unknown>): ToolRequest {
  return {
    name,
    args,
    context: createContext(projectRoot),
  };
}

function expectError(result: ToolDomainResult, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected domain error');
  }
  expect(result.code).toBe(code);
  return result;
}

describe('tool router domain contract', () => {
  let projectRoot = '';

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = '';
    }
  });

  it('returns not_found for removed provider tools', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const service = createExecutionService();

    const result = await routeToolCall(
      createRequest(projectRoot, 'codex', { op: 'exec', prompt: 'hello' }),
      createHelpers(service),
    );

    expectError(result, 'not_found');
  });

  it.each([
    ['kb_memo', { topic: 'note', content: 'memo', owner: 'bad owner' }],
    ['kb_memo_list', { owner: 123 }],
    ['kb_memo_delete', { pattern: '*', owner: 'bad owner' }],
    ['kb_memo_purge', { owner: {} }],
  ])('rejects invalid KB memo owners for %s', async (name, args) => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));

    const result = await routeToolCall(
      createRequest(projectRoot, name, args),
      createHelpers(createExecutionService()),
      createKbSubsystem(),
    );

    expectError(result, 'invalid_request');
  });

  it('normalizes unknown KB tools into domain errors', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));

    const result = await routeToolCall(
      createRequest(projectRoot, 'kb_missing', {}),
      createHelpers(createExecutionService()),
      createKbSubsystem(),
    );

    expect(result).toEqual({
      ok: false,
      code: 'unknown_tool',
      message: 'Unknown tool: kb_missing',
      detail: { name: 'kb_missing' },
    });
  });

  it('returns kb_unavailable when kbSubsystem is null', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const service = createExecutionService();
    const helpers = createHelpers(service);
    const request = createRequest(projectRoot, 'kb_search', { query: 'test' });

    const result = await routeToolCall(request, helpers, null);
    expectError(result, 'kb_unavailable');
  });

  it('routes kb tools through handler when kbSubsystem is present', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const service = createExecutionService();
    const helpers = createHelpers(service);
    const request = createRequest(projectRoot, 'kb_search', { query: 'test' });
    const kbSub = createKbSubsystem();

    const result = await routeToolCall(request, helpers, kbSub);
    // Reaches KB handler (validation error), not 'not_found' or 'kb_unavailable'
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).not.toBe('not_found');
      expect(result.code).not.toBe('kb_unavailable');
    }
  });
});
