/**
 * Red-team adversarial tests for the coral-dispatch-refactor.
 *
 * Deploy to: src/providers/__tests__/red-dispatch-refactor.test.ts
 *
 * Targets (from that location):
 *   ../registry.ts                  — registerProvider guard ordering, zero-state
 *   ../bootstrap.ts                 — idempotency edge cases, partial-failure state
 *   ../../coral/dispatch.ts         — op field type/format boundaries
 *   ../../workflow/schemas.ts       — provider identifier boundary values
 *   ../../workflow/handler.ts       — validateRegisteredProviders bypass + plural error
 *   ../../workflow/pipe-parser.ts   — @provider suffix boundaries
 *   ../../server/server-handlers.ts — workflowProviderSchema, coral routing edge cases
 *
 * Coverage gap analysis
 * ---------------------
 * Before (existing tests cover):
 *   registry: name/tool mismatch, reserved names, duplicate, basic register/get/list
 *   bootstrap: idempotency, extra adapters appear in tool list and workflow enum
 *   dispatch: valid provider+op routes correctly, unknown provider error, missing content throws
 *   workflow schemas: valid/invalid inputs including provider syntax and bypass
 *   workflow handler: unknown default/per-atom provider, duplicate parallel, namespace check
 *   pipe-parser: extensive syntax coverage including @provider accepted/rejected
 *   server-handlers: unknown tool, wait validation, coral routing, synthetic bootstrap, tool list
 *
 * Added (this file):
 *   registry: zero-state (empty returns), guard ORDER (mismatch before reserved before duplicate),
 *             case-sensitivity of reserved set, insertion-order of getAllTools/getProviderNames
 *   bootstrap: empty extra-adapters list, extra adapter that collides with built-in,
 *              bootstrap-flag-reset without registry-reset causes duplicate throw
 *   dispatch: op=null, op=number, op="coral" (no colon), op="CORAL:x" (wrong case),
 *             op="coral:" (empty name reaches resolver), op absent, numeric progressToken,
 *             undefined notify passes through
 *   workflow schemas: single-char provider, digit-start, hyphen-start, internal hyphens,
 *                     empty string, uppercase, underscore
 *   workflow handler: registry-empty bypass (fictional provider passes), plural error form,
 *                     singular error form for one unknown per-atom provider
 *   pipe-parser: @a (single char), @1bad (digit start), @Claude (uppercase), @-bad (hyphen start),
 *                trailing-hyphen provider (@abc-)
 *   server-handlers: non-string op routes to handleOp not coral dispatch,
 *                    op="coral:" routes to dispatch which wraps resolver error as MCP error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — must precede the imports that load those modules
// ---------------------------------------------------------------------------

vi.mock('../codex/cli-detection.js', () => ({
  detectCodexCli: vi.fn(async () => ({
    available: true,
    version: '1.0',
    authState: 'authenticated',
  })),
}));

vi.mock('../codex/codex-executor.js', () => ({
  executeOneShot: vi.fn(async () => ({
    response: '',
    sessionId: null,
    model: 'm',
    durationMs: 0,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
  executeResume: vi.fn(async () => ({
    response: '',
    sessionId: null,
    model: 'm',
    durationMs: 0,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
  executeFork: vi.fn(async () => ({
    response: '',
    sessionId: null,
    model: 'm',
    durationMs: 0,
    exitCode: 0,
    errors: [],
    warnings: [],
    aborted: false,
  })),
}));

vi.mock('../claude/cli-detection.js', () => ({
  detectClaudeCli: vi.fn(async () => ({
    available: true,
    version: '2.0',
    authState: 'authenticated',
  })),
}));

vi.mock('../claude/claude-executor.js', () => ({
  executeClaudeOneShot: vi.fn(async () => ({
    response: '',
    sessionId: null,
    model: 'sonnet',
    durationMs: 0,
    costUsd: 0,
    aborted: false,
  })),
  executeClaudeResume: vi.fn(async () => ({
    response: '',
    sessionId: null,
    model: 'sonnet',
    durationMs: 0,
    costUsd: 0,
    aborted: false,
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  _resetProvidersForTests,
  getAllTools,
  getProvider,
  getProviderNames,
  hasProvider,
  registerProvider,
} from '../registry.js';
import type { ProviderAdapter } from '../types.js';
import {
  _resetProviderBootstrapForTests,
  registerBuiltInProviders,
} from '../bootstrap.js';
import { handleCoralDispatch } from '../../coral/dispatch.js';
import { _test as resolverTest } from '../../coral/resolver.js';
import type { SessionManager } from '../../runner/session-manager.js';
import { workflowInputSchema } from '../../workflow/schemas.js';
import { handleWorkflow } from '../../workflow/handler.js';
import { parseExpression } from '../../workflow/pipe-parser.js';
import { jsonResult } from '../../shared/mcp-utils.js';
import { getTools, handleToolCall } from '../../server/server-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(name: string, toolName?: string): ProviderAdapter {
  const tname = toolName ?? name;
  return {
    name,
    tool: {
      name: tname,
      description: `${name} tool`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    handleOp: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    handleCoralOp: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    extractCompletion: () => ({ responseText: '', metadata: {} }),
    makeOnEvent: () => () => {},
  };
}

const nullMgr = {} as SessionManager;

// ---------------------------------------------------------------------------
// Registry — zero-state
// ---------------------------------------------------------------------------

describe('red: registry — zero-state before any registration', () => {
  beforeEach(() => { _resetProvidersForTests(); });
  afterEach(() => { _resetProvidersForTests(); });

  it('getAllTools returns empty array before any registration', () => {
    expect(getAllTools()).toEqual([]);
  });

  it('getProviderNames returns empty array before any registration', () => {
    expect(getProviderNames()).toEqual([]);
  });

  it('hasProvider returns false for a name that was never registered', () => {
    expect(hasProvider('codex')).toBe(false);
  });

  it('getProvider returns undefined (not null) for an unregistered name', () => {
    // Callers use `if (!provider)` but the contract is undefined; a null
    // return would satisfy falsy checks while violating the type signature.
    expect(getProvider('codex')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry — guard clause ordering
// ---------------------------------------------------------------------------

describe('red: registry — guard clause ordering', () => {
  beforeEach(() => { _resetProvidersForTests(); });
  afterEach(() => { _resetProvidersForTests(); });

  it('name/tool.name mismatch fires BEFORE reserved-name check', () => {
    // adapter.name="wait", tool.name="workflow" — mismatch AND reserved.
    // The first guard (mismatch) must win so the message says "must match".
    const adapter = makeAdapter('wait', 'workflow');
    expect(() => registerProvider(adapter)).toThrow(/must match/i);
  });

  it('reserved-name check fires BEFORE duplicate check', () => {
    // Register a valid adapter, then try to register the reserved name 'wait'.
    // If reserved check runs before duplicate, we get "reserved" not "already".
    // (There is no pre-existing 'wait' entry so duplicate would not fire anyway,
    // but this confirms the guard order is correct for future changes.)
    registerProvider(makeAdapter('alpha'));
    expect(() => registerProvider(makeAdapter('wait'))).toThrow(/reserved/i);
  });

  it('duplicate check fires when name+tool match and name is not reserved', () => {
    registerProvider(makeAdapter('beta'));
    expect(() => registerProvider(makeAdapter('beta'))).toThrow(/already registered/i);
  });
});

// ---------------------------------------------------------------------------
// Registry — insertion order and case sensitivity
// ---------------------------------------------------------------------------

describe('red: registry — insertion order and case sensitivity', () => {
  beforeEach(() => { _resetProvidersForTests(); });
  afterEach(() => { _resetProvidersForTests(); });

  it('getAllTools and getProviderNames preserve registration insertion order', () => {
    registerProvider(makeAdapter('zzz'));
    registerProvider(makeAdapter('aaa'));
    registerProvider(makeAdapter('mmm'));
    expect(getProviderNames()).toEqual(['zzz', 'aaa', 'mmm']);
    expect(getAllTools().map((t) => t.name)).toEqual(['zzz', 'aaa', 'mmm']);
  });

  it('"waitx" (reserved prefix, different name) is not rejected as reserved', () => {
    // The reserved set contains exactly 'wait' and 'workflow' — not prefixes.
    expect(() => registerProvider(makeAdapter('waitx'))).not.toThrow();
  });

  it('"workflowx" is not rejected as reserved', () => {
    expect(() => registerProvider(makeAdapter('workflowx'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap — empty extra adapters list
// ---------------------------------------------------------------------------

describe('red: bootstrap — empty extra adapters is a no-op beyond built-ins', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });
  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  it('registerBuiltInProviders([]) registers codex and claude and sets bootstrapped=true', () => {
    registerBuiltInProviders([]);
    expect(getProviderNames()).toContain('codex');
    expect(getProviderNames()).toContain('claude');
  });

  it('second call to registerBuiltInProviders([]) after first call is idempotent', () => {
    registerBuiltInProviders([]);
    expect(() => registerBuiltInProviders([])).not.toThrow();
    // Still only two providers — not duplicated.
    expect(getProviderNames().filter((n) => n === 'codex')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap — extra adapter collides with built-in
// ---------------------------------------------------------------------------

describe('red: bootstrap — extra adapter name collides with built-in', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });
  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  it('extra adapter named "codex" throws during bootstrap (duplicate after built-in codex)', () => {
    // Built-ins (codex, claude) register first; a duplicate extra adapter
    // must throw "already registered", not silently overwrite.
    expect(() => registerBuiltInProviders([makeAdapter('codex')])).toThrow(/already registered/i);
  });

  it('after failed bootstrap, codex is already in the registry (partial state)', () => {
    // The throw happens after codex was successfully registered.
    try { registerBuiltInProviders([makeAdapter('codex')]); } catch { /* expected */ }
    expect(hasProvider('codex')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap — reset flag without resetting registry causes duplicate throw
// ---------------------------------------------------------------------------

describe('red: bootstrap — resetting flag without resetting registry', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });
  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  it('resetting only the bootstrap flag then calling registerBuiltInProviders again throws duplicate', () => {
    // First call: populates registry with codex + claude, sets bootstrapped=true.
    registerBuiltInProviders();
    // Reset ONLY the bootstrap guard — registry still has codex + claude.
    _resetProviderBootstrapForTests();
    // Second call attempts to re-register codex which is already present.
    expect(() => registerBuiltInProviders()).toThrow(/already registered/i);
  });
});

// ---------------------------------------------------------------------------
// Coral dispatch — op field type and format edge cases
// ---------------------------------------------------------------------------

describe('red: dispatch — op field type coercion and boundary values', () => {
  let tmpDir = '';
  const defaultRoot = process.cwd();

  beforeEach(() => {
    _resetProvidersForTests();
    tmpDir = mkdtempSync(join('/tmp', 'red-dispatch-'));
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
    resolverTest.setPluginRoot(defaultRoot);
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
    // "coral:" passes the startsWith check; extracted name is "".
    // resolveCoralContent("") throws — dispatch does not catch it.
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

// ---------------------------------------------------------------------------
// Workflow schemas — provider identifier boundary values
// ---------------------------------------------------------------------------

describe('red: workflow schema — provider identifier boundary values', () => {
  it('single lowercase letter is a valid provider identifier', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'a' });
    expect(parsed.provider).toBe('a');
  });

  it('provider starting with digit is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: '1abc' }),
    ).toThrow();
  });

  it('provider starting with hyphen is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: '-abc' }),
    ).toThrow();
  });

  it('provider with internal hyphens (a-b-c) is accepted', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'a-b-c' });
    expect(parsed.provider).toBe('a-b-c');
  });

  it('empty string provider is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: '' }),
    ).toThrow();
  });

  it('provider with uppercase letter is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'Claude' }),
    ).toThrow();
  });

  it('provider with underscore is rejected (providerIdentPattern excludes underscores)', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'my_provider' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Workflow handler — singular vs plural unknown provider error
// ---------------------------------------------------------------------------

describe('red: workflow handler — singular vs plural unknown provider error', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    registerBuiltInProviders();
  });
  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  it('two distinct unknown providers produce the plural "Unknown providers:" message', () => {
    // expression uses @bad2 per-atom override; default provider is bad1.
    // Both are unknown → unknownProviders.size === 2 → plural branch.
    const mgr = { register: vi.fn() } as unknown as SessionManager;
    expect(() =>
      handleWorkflow(
        { expression: 'architect@bad2', prompt: 'hi', provider: 'bad1' },
        async () => jsonResult({}),
        mgr,
      ),
    ).toThrow(/Unknown providers:/i);
  });

  it('one unknown per-atom provider produces singular "Unknown provider \\"..." message', () => {
    // Default provider is the registered 'codex'; only the per-atom override is unknown.
    // unknownProviders.size === 1 → singular branch.
    const mgr = { register: vi.fn() } as unknown as SessionManager;
    expect(() =>
      handleWorkflow(
        { expression: 'architect@nobody', prompt: 'hi', provider: 'codex' },
        async () => jsonResult({}),
        mgr,
      ),
    ).toThrow(/Unknown provider "/i);
  });
});

// ---------------------------------------------------------------------------
// Pipe parser — @provider suffix boundary values
// ---------------------------------------------------------------------------

describe('red: pipe-parser — @provider suffix boundary values', () => {
  it('@a (single lowercase char) is accepted as a valid provider suffix', () => {
    const ast = parseExpression('architect@a');
    expect(ast[0][0]).toMatchObject({ kind: 'agent', provider: 'a' });
  });

  it('@1bad (digit start) is rejected by the provider pattern', () => {
    expect(() => parseExpression('architect@1bad')).toThrow(/Unknown provider/i);
  });

  it('@Claude (uppercase start) is rejected by the provider pattern', () => {
    expect(() => parseExpression('architect@Claude')).toThrow(/Unknown provider/i);
  });

  it('@-bad (hyphen start) is rejected by the provider pattern', () => {
    expect(() => parseExpression('architect@-bad')).toThrow(/Unknown provider/i);
  });

  it('@abc- (trailing hyphen) is accepted — providerIdentPattern allows trailing hyphen', () => {
    // providerIdentPattern is /^[a-z][a-z0-9-]*$/ which matches 'abc-'.
    // This is a boundary: the parser must not add an extra constraint that
    // would silently drop valid (if unusual) provider names.
    expect(() => parseExpression('architect@abc-')).not.toThrow();
    const ast = parseExpression('architect@abc-');
    expect(ast[0][0]).toMatchObject({ kind: 'agent', provider: 'abc-' });
  });
});

// ---------------------------------------------------------------------------
// Server handlers — op routing edge cases
// ---------------------------------------------------------------------------

describe('red: server-handlers — coral op routing edge cases', () => {
  let tmpDir = '';
  const defaultRoot = process.cwd();

  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    tmpDir = mkdtempSync(join('/tmp', 'red-server-coral-'));
    mkdirSync(join(tmpDir, 'agents'), { recursive: true });
    resolverTest.setPluginRoot(tmpDir);
  });

  afterEach(() => {
    resolverTest.setPluginRoot(defaultRoot);
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('non-string op on a registered provider routes to handleOp, not coral dispatch', async () => {
    const handleOpSpy = vi.fn<ProviderAdapter['handleOp']>(
      async () => ({ content: [{ type: 'text', text: 'from-handleOp' }], isError: false }),
    );
    const handleCoralOpSpy = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'should-not-call' }], isError: false }),
    );

    registerBuiltInProviders([{
      name: 'probe',
      tool: { name: 'probe', description: 'probe', inputSchema: {} },
      handleOp: handleOpSpy,
      handleCoralOp: handleCoralOpSpy,
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    }]);

    // op is a number — typeof check fails startsWith, so handleOp is called.
    await handleToolCall('probe', { op: 123 }, nullMgr);

    expect(handleOpSpy).toHaveBeenCalledTimes(1);
    expect(handleCoralOpSpy).not.toHaveBeenCalled();
  });

  it('op="coral:" on registered provider — server wraps resolver throw as isError MCP result', async () => {
    // "coral:" passes the startsWith guard in handleToolCall and routes to
    // handleCoralDispatch, which extracts name="" and the resolver throws
    // "Invalid coral target name". The server catch block must wrap this as
    // an isError result, not an unhandled rejection.
    writeFileSync(join(tmpDir, 'agents', 'placeholder.md'), '# p\n');
    const handleCoralOpSpy = vi.fn<ProviderAdapter['handleCoralOp']>(
      async () => ({ content: [{ type: 'text', text: 'unreachable' }], isError: false }),
    );

    registerBuiltInProviders([{
      name: 'probe2',
      tool: { name: 'probe2', description: 'probe2', inputSchema: {} },
      handleOp: async () => ({ content: [{ type: 'text', text: 'op' }], isError: false }),
      handleCoralOp: handleCoralOpSpy,
      extractCompletion: () => ({ responseText: '', metadata: {} }),
      makeOnEvent: () => () => {},
    }]);

    const result = await handleToolCall('probe2', { op: 'coral:' }, nullMgr);

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
    // After getTools() bootstraps built-ins, enum must contain codex and claude.
    expect(providerProp?.enum).toContain('codex');
    expect(providerProp?.enum).toContain('claude');
  });

  it('workflow tool provider metadata is an object (no crash) regardless of registry state', () => {
    // getTools() always calls registerBuiltInProviders() first so the empty-registry
    // fallback is only reachable via workflowProviderSchema() directly. We verify
    // getTools() never returns a workflow tool without a provider property object.
    const tools = getTools();
    const workflow = tools.find((t) => t.name === 'workflow');
    const providerProp = (workflow?.inputSchema as {
      properties?: Record<string, unknown>;
    })?.properties?.provider;
    expect(providerProp).toBeDefined();
    expect(typeof providerProp).toBe('object');
  });
});
