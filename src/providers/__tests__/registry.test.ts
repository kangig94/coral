import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpResult } from '../../shared/mcp-utils.js';
import {
  _resetProvidersForTests,
  getAllTools,
  getProvider,
  getProviderNames,
  hasProvider,
  registerProvider,
} from '../registry.js';
import {
  _resetProviderBootstrapForTests,
  registerBuiltInProviders,
} from '../bootstrap.js';
import type { ProviderAdapter } from '../types.js';

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
    extractCompletion: (result: McpResult) => ({
      responseText: result.content[0]?.text ?? '',
      metadata: {},
    }),
    makeOnEvent: () => () => {},
  };
}

describe('providers registry', () => {
  beforeEach(() => {
    _resetProvidersForTests();
  });

  it('registers and resolves providers', () => {
    const adapter = makeAdapter('codex-like');
    registerProvider(adapter);

    expect(hasProvider('codex-like')).toBe(true);
    expect(getProvider('codex-like')).toBe(adapter);
    expect(getAllTools().map((tool) => tool.name)).toEqual(['codex-like']);
    expect(getProviderNames()).toEqual(['codex-like']);
  });

  it('rejects adapter.name and adapter.tool.name mismatch', () => {
    const adapter = makeAdapter('one');
    adapter.tool.name = 'two';
    expect(() => registerProvider(adapter)).toThrow('must match');
  });

  it('rejects reserved provider names', () => {
    expect(() => registerProvider(makeAdapter('wait'))).toThrow('reserved');
    expect(() => registerProvider(makeAdapter('workflow'))).toThrow('reserved');
    expect(() => registerProvider(makeAdapter('abort'))).toThrow('reserved');
  });

  it('rejects duplicate provider registrations', () => {
    registerProvider(makeAdapter('dup'));
    expect(() => registerProvider(makeAdapter('dup'))).toThrow('already registered');
  });
});

describe('registry — zero-state before any registration', () => {
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
    expect(getProvider('codex')).toBeUndefined();
  });
});

describe('registry — guard clause ordering', () => {
  beforeEach(() => { _resetProvidersForTests(); });
  afterEach(() => { _resetProvidersForTests(); });

  it('name/tool.name mismatch fires BEFORE reserved-name check', () => {
    const adapter = makeAdapter('wait', 'workflow');
    expect(() => registerProvider(adapter)).toThrow(/must match/i);
  });

  it('reserved-name check fires BEFORE duplicate check', () => {
    registerProvider(makeAdapter('alpha'));
    expect(() => registerProvider(makeAdapter('wait'))).toThrow(/reserved/i);
  });

});

describe('registry — insertion order and case sensitivity', () => {
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
    expect(() => registerProvider(makeAdapter('waitx'))).not.toThrow();
  });

  it('"workflowx" is not rejected as reserved', () => {
    expect(() => registerProvider(makeAdapter('workflowx'))).not.toThrow();
  });
});

describe('bootstrap — empty extra adapters is a no-op beyond built-ins', () => {
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
    expect(getProviderNames().filter((n) => n === 'codex')).toHaveLength(1);
  });
});

describe('bootstrap — extra adapter name collides with built-in', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });
  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  it('extra adapter named "codex" throws during bootstrap (duplicate after built-in codex)', () => {
    expect(() => registerBuiltInProviders([makeAdapter('codex')])).toThrow(/already registered/i);
  });

  it('after failed bootstrap, codex is already in the registry (partial state)', () => {
    try { registerBuiltInProviders([makeAdapter('codex')]); } catch { /* expected */ }
    expect(hasProvider('codex')).toBe(true);
  });
});

describe('bootstrap — resetting flag without resetting registry', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });
  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  it('resetting only the bootstrap flag then calling registerBuiltInProviders again throws duplicate', () => {
    registerBuiltInProviders();
    _resetProviderBootstrapForTests();
    expect(() => registerBuiltInProviders()).toThrow(/already registered/i);
  });
});
