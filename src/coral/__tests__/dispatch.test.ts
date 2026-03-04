import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleCoralDispatch } from '../dispatch.js';
import { _test as resolverTest } from '../resolver.js';
import { _resetProvidersForTests, registerProvider } from '../../providers/registry.js';
import type { ProviderAdapter } from '../../providers/types.js';
import type { SessionManager } from '../../runner/session-manager.js';
import type { McpResult } from '../../shared/mcp-utils.js';

let tmpDir = '';
const defaultPluginRoot = process.cwd();

describe('coral dispatch', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    tmpDir = mkdtempSync(join('/tmp', 'coral-dispatch-test-'));
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), '# Architect\nAgent content\n');
    resolverTest.setPluginRoot(tmpDir);
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    _resetProvidersForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes coral dispatch to the registered provider adapter', async () => {
    const okResult: McpResult = { content: [{ type: 'text', text: 'ok' }], isError: false };
    const handleCoralOp = vi.fn<ProviderAdapter['handleCoralOp']>(async () => okResult);
    const adapter: ProviderAdapter = {
      name: 'mock-provider',
      tool: { name: 'mock-provider', description: 'mock', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'unused' }], isError: false }),
      handleCoralOp,
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    };
    registerProvider(adapter);

    const mgr = {} as SessionManager;
    const result = await handleCoralDispatch(
      'mock-provider',
      { op: 'coral:architect', prompt: 'Run checks' },
      mgr,
      'token-1',
      async () => {},
    );

    expect(result.isError).toBe(false);
    expect(handleCoralOp).toHaveBeenCalledTimes(1);
    const [coralName, coralContent, rawArgs, passedMgr, progressToken] = handleCoralOp.mock.calls[0] ?? [];
    expect(coralName).toBe('architect');
    expect(String(coralContent)).toContain('# Architect');
    expect(rawArgs).toEqual({ op: 'coral:architect', prompt: 'Run checks' });
    expect(passedMgr).toBe(mgr);
    expect(progressToken).toBe('token-1');
  });

  it('returns an MCP error when provider is unknown', async () => {
    const result = await handleCoralDispatch(
      'unknown-provider',
      { op: 'coral:architect', prompt: 'Run checks' },
      {} as SessionManager,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown provider: unknown-provider');
  });

  it('throws missing-content errors from resolver with stable shape', async () => {
    registerProvider({
      name: 'mock-provider',
      tool: { name: 'mock-provider', description: 'mock', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'unused' }], isError: false }),
      handleCoralOp: async () => ({ content: [{ type: 'text', text: 'unused' }], isError: false }),
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    });

    await expect(handleCoralDispatch(
      'mock-provider',
      { op: 'coral:does-not-exist', prompt: 'Run checks' },
      {} as SessionManager,
    )).rejects.toThrow('Coral content not found: does-not-exist');
  });
});
