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

  it('normalizes rejected provider launch decisions into domain errors', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const rejected = {
      status: 'rejected',
      phase: 'preflight',
      code: 'busy',
      message: 'Session is already running a job',
    } satisfies LaunchDecision;
    const service = createExecutionService({
      start: vi.fn(async () => rejected),
    });

    const result = await routeToolCall(
      createRequest(projectRoot, 'codex', { op: 'exec', prompt: 'hello' }),
      createHelpers(service),
    );

    expect(result).toEqual({
      ok: false,
      code: 'busy',
      message: 'Session is already running a job',
    });
  });

  it('normalizes rejected workflow launch decisions into domain errors', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const service = createExecutionService();

    const result = await routeToolCall(
      createRequest(projectRoot, 'workflow', {
        expression: 'architect@missing-provider',
        init_prompt: 'hello',
        provider: 'codex',
      }),
      createHelpers(service),
    );

    expect(result).toEqual({
      ok: false,
      code: 'unknown_provider',
      message: 'Unknown provider: missing-provider',
    });
  });

  it.each([
    [{ expression: 'architect' }, /init_prompt/i],
    [{ expression: 'architect ->', init_prompt: 'hello' }, /Expected step expression after "->"/],
    [{ expression: '(architect, architect)', init_prompt: 'hello' }, /Duplicate atom/],
  ])('normalizes workflow validation failures for %j', async (args, message) => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const service = createExecutionService();

    const result = await routeToolCall(createRequest(projectRoot, 'workflow', args), createHelpers(service));

    const error = expectError(result, 'invalid_request');
    expect(error.message).toMatch(message);
    expect(service.executeWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    [{ op: 'coral:architect', prompt: 'hello', owner: 123 }, /owner/i],
    [{ op: 'coral:architect', prompt: 'hello', owner: 'bad owner' }, /Owner must be token-safe/],
    [{ op: 'coral:architect', prompt: '' }, /Prompt is required/],
    [{ op: 'coral:Bad', prompt: 'hello' }, /Op must be coral/],
  ])('normalizes malformed coral requests for %j', async (args, message) => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const service = createExecutionService();

    const result = await routeToolCall(createRequest(projectRoot, 'codex', args), createHelpers(service));

    const error = expectError(result, 'invalid_request');
    expect(error.message).toMatch(message);
    expect(service.coralDispatch).not.toHaveBeenCalled();
  });

  it('normalizes unresolved coral targets into invalid_request domain errors', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'coral-tool-router-'));
    const service = createExecutionService({
      coralDispatch: vi.fn(async () => {
        throw new Error(
          'Coral content not found: missing (expected agents/missing.md or skills/missing/SKILL.md)',
        );
      }),
    });

    const result = await routeToolCall(
      createRequest(projectRoot, 'codex', { op: 'coral:missing', prompt: 'hello' }),
      createHelpers(service),
    );

    const error = expectError(result, 'invalid_request');
    expect(error.message).toContain('Coral content not found: missing');
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
});
