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
const nullMgr = {} as SessionManager;

const okResult: McpResult = { content: [{ type: 'text', text: 'ok' }], isError: false };

function makeMockProvider(
  handleCoralOp: ProviderAdapter['handleCoralOp'],
  name = 'mock-provider',
): ProviderAdapter {
  return {
    name,
    tool: { name, description: 'mock', inputSchema: {} },
    handleOp: async () => ({ content: [{ type: 'text', text: 'unused' }], isError: false }),
    handleCoralOp,
    extractCompletion: () => ({ responseText: '', metadata: {} }),
    makeOnEvent: () => () => {},
  };
}

function setupResolverFixture(tmpPrefix: string, architectContent: string): void {
  tmpDir = mkdtempSync(join('/tmp', tmpPrefix));
  mkdirSync(join(tmpDir, 'agents'), { recursive: true });
  writeFileSync(join(tmpDir, 'agents', 'architect.md'), architectContent);
  resolverTest.setPluginRoot(tmpDir);
}

beforeEach(() => {
  _resetProvidersForTests();
});

afterEach(() => {
  resolverTest.setPluginRoot(defaultPluginRoot);
  _resetProvidersForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('coral dispatch', () => {
  beforeEach(() => {
    setupResolverFixture(
      'coral-dispatch-test-',
      [
        '---',
        'title: Architect Agent',
        '---',
        '',
        '> **CORAL_METHODS**: use method list',
        '# Architect',
        'Agent content',
        '',
      ].join('\n'),
    );
  });

  it('routes coral dispatch to the registered provider adapter', async () => {
    const handleCoralOp = vi.fn<ProviderAdapter['handleCoralOp']>(async () => okResult);
    registerProvider(makeMockProvider(handleCoralOp));

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
    expect(coralContent).toBe('# Architect\nAgent content');
    expect(String(coralContent)).not.toContain('---');
    expect(String(coralContent)).not.toContain('CORAL_METHODS');
    expect(rawArgs).toEqual({ op: 'coral:architect', prompt: 'Run checks', effort: 'xhigh' });
    expect(passedMgr).toBe(mgr);
    expect(progressToken).toBe('token-1');
  });

  it('defaults effort to xhigh when not specified', async () => {
    const handleCoralOp = vi.fn<ProviderAdapter['handleCoralOp']>(async () => okResult);
    registerProvider(makeMockProvider(handleCoralOp));

    await handleCoralDispatch('mock-provider', { op: 'coral:architect', prompt: 'go' }, nullMgr);

    const [, , rawArgs] = handleCoralOp.mock.calls[0] ?? [];
    expect(rawArgs).toHaveProperty('effort', 'xhigh');
  });

  it('preserves explicit effort and does not override with xhigh', async () => {
    const handleCoralOp = vi.fn<ProviderAdapter['handleCoralOp']>(async () => okResult);
    registerProvider(makeMockProvider(handleCoralOp));

    await handleCoralDispatch('mock-provider', { op: 'coral:architect', prompt: 'go', effort: 'low' }, nullMgr);

    const [, , rawArgs] = handleCoralOp.mock.calls[0] ?? [];
    expect(rawArgs).toHaveProperty('effort', 'low');
  });

  it('returns an MCP error when provider is unknown', async () => {
    const result = await handleCoralDispatch(
      'unknown-provider',
      { op: 'coral:architect', prompt: 'Run checks' },
      nullMgr,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown provider: unknown-provider');
  });

  it('throws missing-content errors from resolver with stable shape', async () => {
    registerProvider(makeMockProvider(async () => okResult));

    await expect(handleCoralDispatch(
      'mock-provider',
      { op: 'coral:does-not-exist', prompt: 'Run checks' },
      nullMgr,
    )).rejects.toThrow('Coral content not found: does-not-exist');
  });
});

describe('dispatch — op field type coercion and boundary values', () => {
  beforeEach(() => {
    setupResolverFixture('coral-dispatch-coerce-', '# Architect\nBody\n');
    registerProvider(makeMockProvider(
      async () => ({ content: [{ type: 'text', text: 'coral-ok' }], isError: false }),
      'mock-p',
    ));
  });

  it.each([
    { label: 'op=null', args: { op: null as unknown as string } },
    { label: 'op=42', args: { op: 42 as unknown as string } },
    { label: 'op="coral"', args: { op: 'coral' } },
    { label: 'op="CORAL:architect"', args: { op: 'CORAL:architect' } },
    { label: 'op absent', args: {} },
  ])('$label returns isError MCP result containing "Invalid coral op"', async ({ args }) => {
    const result = await handleCoralDispatch('mock-p', args, nullMgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid coral op');
  });

  it('op="coral:" (empty name after prefix) propagates resolver throw', async () => {
    await expect(
      handleCoralDispatch('mock-p', { op: 'coral:' }, nullMgr),
    ).rejects.toThrow(/Invalid coral target name/i);
  });

  it('numeric progressToken passes through to handleCoralOp unchanged', async () => {
    const spy = vi.fn<ProviderAdapter['handleCoralOp']>(async () => okResult);
    _resetProvidersForTests();
    registerProvider(makeMockProvider(spy, 'mock-p'));

    await handleCoralDispatch('mock-p', { op: 'coral:architect' }, nullMgr, 99);

    const [, , , , progressToken] = spy.mock.calls[0] ?? [];
    expect(progressToken).toBe(99);
  });

  it('undefined notify passes through to handleCoralOp as undefined', async () => {
    const spy = vi.fn<ProviderAdapter['handleCoralOp']>(async () => okResult);
    _resetProvidersForTests();
    registerProvider(makeMockProvider(spy, 'mock-p'));

    await handleCoralDispatch('mock-p', { op: 'coral:architect' }, nullMgr, undefined, undefined);

    const [, , , , , notifyArg] = spy.mock.calls[0] ?? [];
    expect(notifyArg).toBeUndefined();
  });
});
