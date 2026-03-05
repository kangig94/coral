import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionManager } from '../../runner/session-manager.js';
import { SessionManager as RealSessionManager } from '../../runner/session-manager.js';
import { activeSessions, type ActiveSession } from '../../runner/job-manager.js';
import { _test as resolverTest } from '../../coral/resolver.js';
import { _resetProviderBootstrapForTests, registerBuiltInProviders } from '../../providers/bootstrap.js';
import { _resetProvidersForTests } from '../../providers/registry.js';
import type { ProviderAdapter } from '../../providers/types.js';
import type { McpResult } from '../../shared/mcp-utils.js';
import { getTools, handleToolCall } from '../server-handlers.js';

let tmpDir = '';
let mgr: SessionManager;
const defaultPluginRoot = process.cwd();

function makeSyntheticAdapter(overrides?: Partial<ProviderAdapter>): ProviderAdapter {
  return {
    name: 'synthetic',
    tool: {
      name: 'synthetic',
      description: 'Synthetic provider for router tests',
      inputSchema: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] },
    },
    handleOp: async () => ({ content: [{ type: 'text', text: 'synthetic-op' }], isError: false }),
    handleCoralOp: async () => ({ content: [{ type: 'text', text: 'synthetic-coral' }], isError: false }),
    extractCompletion: () => ({ responseText: '', metadata: {} }),
    makeOnEvent: () => () => {},
    ...overrides,
  };
}

describe('ax server-handlers router', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-server-router-test-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), '# Architect\nAgent body\n');
    resolverTest.setPluginRoot(tmpDir);
    mgr = new RealSessionManager(join(tmpDir, 'workspace'));

    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes built-in provider tools plus wait and workflow', () => {
    const names = getTools().map((tool) => tool.name).sort();
    expect(names).toEqual(['abort', 'claude', 'codex', 'wait', 'workflow']);
  });

  it('returns isError for unknown tool names', async () => {
    const result = await handleToolCall('unknown-tool', { op: 'list' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool: unknown-tool');
  });

  it('validates wait tool input via zod schema', async () => {
    const result = await handleToolCall('wait', { sessions: [] }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('At least one session required');
  });

  it('validates abort tool input via zod schema', async () => {
    const result = await handleToolCall('abort', { sessions: [] }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('At least one session required');
  });

  it('abort tool returns not_found for unknown sessions', async () => {
    const result = await handleToolCall('abort', { sessions: ['12345678-1234-4234-8234-123456789abc'] }, mgr);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text) as { results: Array<{ status: string }> };
    expect(data.results[0].status).toBe('not_found');
  });

  it('bootstraps a synthetic provider through single bootstrap touchpoint', async () => {
    const synthetic = makeSyntheticAdapter();
    registerBuiltInProviders([synthetic]);

    const names = getTools().map((tool) => tool.name);
    expect(names).toContain('synthetic');

    const workflowTool = getTools().find((tool) => tool.name === 'workflow');
    const providerProperty = (workflowTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.provider as {
      enum?: string[];
    };
    expect(providerProperty.enum).toContain('synthetic');

    const result = await handleToolCall('synthetic', { op: 'ping' }, mgr);
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('synthetic-op');
  });

  it('routes coral ops through provider handleCoralOp dispatch', async () => {
    const okResult: McpResult = { content: [{ type: 'text', text: 'coral-ok' }], isError: false };
    const handleCoralOp = vi.fn<ProviderAdapter['handleCoralOp']>(async () => okResult);
    registerBuiltInProviders([makeSyntheticAdapter({ handleCoralOp })]);

    const result = await handleToolCall('synthetic', { op: 'coral:architect', prompt: 'Run checks' }, mgr);

    expect(result.isError).toBe(false);
    expect(handleCoralOp).toHaveBeenCalledTimes(1);
    const [coralName, coralContent] = handleCoralOp.mock.calls[0] ?? [];
    expect(coralName).toBe('architect');
    expect(String(coralContent)).toContain('# Architect');
  });

  it('non-string op on a registered provider routes to handleOp, not coral dispatch', async () => {
    const handleOpSpy = vi.fn<ProviderAdapter['handleOp']>(
      async () => ({ content: [{ type: 'text', text: 'from-handleOp' }], isError: false }),
    );
    const handleCoralOpSpy = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'should-not-call' }], isError: false }),
    );

    registerBuiltInProviders([makeSyntheticAdapter({
      handleOp: handleOpSpy,
      handleCoralOp: handleCoralOpSpy,
    })]);

    await handleToolCall('synthetic', { op: 123 }, mgr);

    expect(handleOpSpy).toHaveBeenCalledTimes(1);
    expect(handleCoralOpSpy).not.toHaveBeenCalled();
  });

  it('op="coral:" on registered provider — server wraps resolver throw as isError MCP result', async () => {
    const handleCoralOpSpy = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'unreachable' }], isError: false }),
    );

    registerBuiltInProviders([makeSyntheticAdapter({
      handleCoralOp: handleCoralOpSpy,
    })]);

    const result = await handleToolCall('synthetic', { op: 'coral:' }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid coral target name');
    expect(handleCoralOpSpy).not.toHaveBeenCalled();
  });

  it('workflow tool provider metadata is an object regardless of registry state', () => {
    const tools = getTools();
    const workflow = tools.find((t) => t.name === 'workflow');
    const providerProp = (workflow?.inputSchema as {
      properties?: Record<string, unknown>;
    })?.properties?.provider;
    expect(providerProp).toBeDefined();
    expect(typeof providerProp).toBe('object');
  });
});

type AbortItem = {
  session: string;
  session_name?: string;
  status: 'abort_requested' | 'not_found';
};

function parseAbortResults(text: string): AbortItem[] {
  return (JSON.parse(text) as { results: AbortItem[] }).results;
}

function registerActiveSession(
  sessionId: string,
  provider: 'codex' | 'claude',
  sessionName: string,
  sessionDir: string,
  controller = new AbortController(),
): AbortController {
  const entry: ActiveSession = {
    provider,
    sessionDir,
    controller,
    sessionName,
    terminalState: 'running',
  };
  activeSessions.set(sessionId, entry);
  return controller;
}

describe('abort tool edge cases', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'coral-abort-edge-'));
    mkdirSync(join(tmpDir, 'workspace'), { recursive: true });
    mgr = new RealSessionManager(join(tmpDir, 'workspace'));
    activeSessions.clear();
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  afterEach(() => {
    activeSessions.clear();
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('aborts codex and claude sessions while preserving not_found items in mixed batches', async () => {
    const codexSession = '00000000-0000-4000-8000-000000000001';
    const missingSession = '00000000-0000-4000-8000-000000000002';
    const claudeSession = '00000000-0000-4000-8000-000000000003';
    const codexController = registerActiveSession(codexSession, 'codex', 'codex-live', join(tmpDir, 'workspace', codexSession));
    const claudeController = registerActiveSession(claudeSession, 'claude', 'claude-live', join(tmpDir, 'workspace', claudeSession));

    const result = await handleToolCall('abort', { sessions: [codexSession, missingSession, claudeSession] }, mgr);

    expect(result.isError).toBe(false);
    expect(parseAbortResults(result.content[0]?.text ?? '')).toEqual([
      { session: codexSession, session_name: 'codex-live', status: 'abort_requested' },
      { session: missingSession, status: 'not_found' },
      { session: claudeSession, session_name: 'claude-live', status: 'abort_requested' },
    ]);
    expect(codexController.signal.aborted).toBe(true);
    expect(claudeController.signal.aborted).toBe(true);
  });

  it('remains stable when aborting an already-aborted controller', async () => {
    const session = '00000000-0000-4000-8000-00000000000a';
    const controller = new AbortController();
    controller.abort();
    registerActiveSession(session, 'codex', 'already-aborted', join(tmpDir, 'workspace', session), controller);

    const result = await handleToolCall('abort', { sessions: [session] }, mgr);

    expect(result.isError).toBe(false);
    expect(parseAbortResults(result.content[0]?.text ?? '')).toEqual([
      { session, session_name: 'already-aborted', status: 'abort_requested' },
    ]);
    expect(controller.signal.aborted).toBe(true);
  });

  it('returns not_found for all sessions when batch contains only unknown UUIDs', async () => {
    const sessions = ['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000011'];
    const result = await handleToolCall('abort', { sessions }, mgr);

    expect(result.isError).toBe(false);
    expect(parseAbortResults(result.content[0]?.text ?? '')).toEqual([
      { session: sessions[0], status: 'not_found' },
      { session: sessions[1], status: 'not_found' },
    ]);
  });

  it('rejects non-UUID strings in sessions array', async () => {
    const result = await handleToolCall('abort', { sessions: ['not-a-uuid'] }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Invalid uuid');
  });
});
