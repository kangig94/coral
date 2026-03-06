import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionManager } from '../../runner/session-manager.js';
import { SessionManager as RealSessionManager } from '../../runner/session-manager.js';
import { _resetProviderBootstrapForTests, registerBuiltInProviders } from '../../providers/bootstrap.js';
import { _resetProvidersForTests } from '../../providers/registry.js';
import type { ProviderAdapter } from '../../providers/types.js';
import { jsonResult } from '../../shared/mcp-utils.js';

vi.mock('../backend-client.js', () => ({
  proxyToolCall: vi.fn(),
}));

import { proxyToolCall } from '../backend-client.js';
import { getTools, handleToolCall } from '../server-handlers.js';

let tmpDir = '';
let mgr: SessionManager;

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
    mgr = new RealSessionManager(join(tmpDir, 'workspace'));
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    vi.mocked(proxyToolCall).mockResolvedValue(jsonResult({ proxied: true }));
  });

  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('exposes built-in provider tools plus wait and workflow', () => {
    const names = getTools().map((tool) => tool.name).sort();
    expect(names).toEqual(['abort', 'claude', 'codex', 'wait', 'workflow']);
  });

  it('bootstraps a synthetic provider through the registry-derived tool list', () => {
    registerBuiltInProviders([makeSyntheticAdapter()]);

    const names = getTools().map((tool) => tool.name);
    expect(names).toContain('synthetic');

    const workflowTool = getTools().find((tool) => tool.name === 'workflow');
    const providerProperty = (workflowTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.provider as {
      enum?: string[];
    };
    expect(providerProperty.enum).toContain('synthetic');
  });

  it('routes unknown tool names through the backend proxy instead of rejecting locally', async () => {
    const result = await handleToolCall('unknown-tool', { op: 'list' }, mgr);

    expect(result.isError).toBe(false);
    expect(proxyToolCall).toHaveBeenCalledWith('unknown-tool', { op: 'list' }, process.cwd());
  });

  it('routes provider tools through the backend proxy without local coral dispatch', async () => {
    registerBuiltInProviders([makeSyntheticAdapter()]);

    const result = await handleToolCall('synthetic', { op: 'coral:architect', prompt: 'Run checks' }, mgr);

    expect(result.isError).toBe(false);
    expect(proxyToolCall).toHaveBeenCalledWith(
      'synthetic',
      { op: 'coral:architect', prompt: 'Run checks' },
      process.cwd(),
    );
  });

  it('routes abort through the backend proxy without local schema validation', async () => {
    const result = await handleToolCall('abort', { sessions: [] }, mgr);

    expect(result.isError).toBe(false);
    expect(proxyToolCall).toHaveBeenCalledWith('abort', { sessions: [] }, process.cwd());
  });

  it('validates wait tool input locally and does not proxy it', async () => {
    const result = await handleToolCall('wait', { sessions: [] }, mgr);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('At least one session required');
    expect(proxyToolCall).not.toHaveBeenCalled();
  });

  it('workflow tool provider metadata is an object regardless of registry state', () => {
    const tools = getTools();
    const workflow = tools.find((tool) => tool.name === 'workflow');
    const providerProp = (workflow?.inputSchema as {
      properties?: Record<string, unknown>;
    })?.properties?.provider;
    expect(providerProp).toBeDefined();
    expect(typeof providerProp).toBe('object');
  });
});
