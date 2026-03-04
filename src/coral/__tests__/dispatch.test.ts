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
    expect(rawArgs).toEqual({ op: 'coral:architect', prompt: 'Run checks', effort: 'xhigh' });
    expect(passedMgr).toBe(mgr);
    expect(progressToken).toBe('token-1');
  });

  it('defaults effort to xhigh when not specified', async () => {
    const handleCoralOp = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    );
    registerProvider({
      name: 'mock-provider',
      tool: { name: 'mock-provider', description: 'mock', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'unused' }], isError: false }),
      handleCoralOp,
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    });

    await handleCoralDispatch('mock-provider', { op: 'coral:architect', prompt: 'go' }, {} as SessionManager);

    const [, , rawArgs] = handleCoralOp.mock.calls[0] ?? [];
    expect(rawArgs).toHaveProperty('effort', 'xhigh');
  });

  it('preserves explicit effort and does not override with xhigh', async () => {
    const handleCoralOp = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    );
    registerProvider({
      name: 'mock-provider',
      tool: { name: 'mock-provider', description: 'mock', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'unused' }], isError: false }),
      handleCoralOp,
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    });

    await handleCoralDispatch('mock-provider', { op: 'coral:architect', prompt: 'go', effort: 'low' }, {} as SessionManager);

    const [, , rawArgs] = handleCoralOp.mock.calls[0] ?? [];
    expect(rawArgs).toHaveProperty('effort', 'low');
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

describe('dispatch — op field type coercion and boundary values', () => {
  const nullMgr = {} as SessionManager;

  beforeEach(() => {
    _resetProvidersForTests();
    tmpDir = mkdtempSync(join('/tmp', 'coral-dispatch-coerce-'));
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', 'architect.md'), '# Architect\nBody\n');
    resolverTest.setPluginRoot(tmpDir);
    registerProvider({
      name: 'mock-p',
      tool: { name: 'mock-p', description: 'mock', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'op' }], isError: false }),
      handleCoralOp: async () => ({ content: [{ type: 'text', text: 'coral-ok' }], isError: false }),
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    });
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultPluginRoot);
    _resetProvidersForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('op=null — returns isError MCP result containing "Invalid coral op"', async () => {
    const result = await handleCoralDispatch(
      'mock-p',
      { op: null as unknown as string },
      nullMgr,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid coral op');
  });

  it('op=42 (number) — returns isError MCP result containing "Invalid coral op"', async () => {
    const result = await handleCoralDispatch(
      'mock-p',
      { op: 42 as unknown as string },
      nullMgr,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid coral op');
  });

  it('op="coral" (no colon) — returns isError MCP result (missing prefix)', async () => {
    const result = await handleCoralDispatch('mock-p', { op: 'coral' }, nullMgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid coral op');
  });

  it('op="CORAL:architect" (wrong case) — returns isError MCP result', async () => {
    const result = await handleCoralDispatch('mock-p', { op: 'CORAL:architect' }, nullMgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid coral op');
  });

  it('op absent entirely — returns isError MCP result', async () => {
    const result = await handleCoralDispatch('mock-p', {}, nullMgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid coral op');
  });

  it('op="coral:" (empty name after prefix) — propagates resolver "Invalid coral target name" throw', async () => {
    await expect(
      handleCoralDispatch('mock-p', { op: 'coral:' }, nullMgr),
    ).rejects.toThrow(/Invalid coral target name/i);
  });

  it('numeric progressToken passes through to handleCoralOp unchanged', async () => {
    const spy = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    );
    _resetProvidersForTests();
    registerProvider({
      name: 'mock-p',
      tool: { name: 'mock-p', description: 'mock', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'op' }], isError: false }),
      handleCoralOp: spy,
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    });

    await handleCoralDispatch('mock-p', { op: 'coral:architect' }, nullMgr, 99);

    const [, , , , progressToken] = spy.mock.calls[0] ?? [];
    expect(progressToken).toBe(99);
  });

  it('undefined notify passes through to handleCoralOp as undefined', async () => {
    const spy = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    );
    _resetProvidersForTests();
    registerProvider({
      name: 'mock-p',
      tool: { name: 'mock-p', description: 'mock', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'op' }], isError: false }),
      handleCoralOp: spy,
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    });

    await handleCoralDispatch('mock-p', { op: 'coral:architect' }, nullMgr, undefined, undefined);

    const [, , , , , notifyArg] = spy.mock.calls[0] ?? [];
    expect(notifyArg).toBeUndefined();
  });
});
