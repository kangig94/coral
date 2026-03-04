import { beforeEach, describe, expect, it } from 'vitest';
import type { McpResult } from '../../shared/mcp-utils.js';
import {
  _resetProvidersForTests,
  getAllTools,
  getProvider,
  getProviderNames,
  hasProvider,
  registerProvider,
} from '../registry.js';
import type { ProviderAdapter } from '../types.js';

function makeAdapter(name: string): ProviderAdapter {
  return {
    name,
    tool: {
      name,
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
  });

  it('rejects duplicate provider registrations', () => {
    registerProvider(makeAdapter('dup'));
    expect(() => registerProvider(makeAdapter('dup'))).toThrow('already registered');
  });
});
