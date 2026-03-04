import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionManager } from '../../runner/session-manager.js';
import { SessionManager as RealSessionManager } from '../../runner/session-manager.js';
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
    expect(names).toEqual(['claude', 'codex', 'wait', 'workflow']);
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

  it('workflow tool provider enum contains registered providers after bootstrap', () => {
    const tools = getTools();
    const workflowTool = tools.find((t) => t.name === 'workflow');
    expect(workflowTool).toBeDefined();
    const providerProp = (workflowTool?.inputSchema as {
      properties?: Record<string, { enum?: string[]; type?: string }>;
    })?.properties?.provider;
    expect(providerProp).toBeDefined();
    expect(providerProp?.enum).toContain('codex');
    expect(providerProp?.enum).toContain('claude');
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
