import { describe, expect, it, vi } from 'vitest';
import type { AppServerTransport } from '#src/providers/contract.js';
import { isCodexSizedModel, readCodexModelCatalog } from '#src/providers/codex/model-catalog.js';
import type { ModelListEntry } from '#src/providers/codex/protocol.js';

function model(slug: string, overrides: Partial<ModelListEntry> = {}): ModelListEntry {
  return {
    model: slug,
    hidden: false,
    upgrade: null,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
    ...overrides,
  };
}

function transport(rpc: AppServerTransport['rpc']): AppServerTransport {
  return {
    rpc,
    subscribe: () => () => {},
    closed: new Promise(() => {}),
  };
}

describe('readCodexModelCatalog', () => {
  it('selects the newest numeric version per size regardless of picker order or isDefault', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          ...model('gpt-6.9-sol'),
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Maximum reasoning effort' }],
        },
        model('gpt-6-sol'),
        model('gpt-5.6-sol'),
        model('gpt-6.10-sol'),
        model('gpt-6.1-sol'),
        model('gpt-6-astra'),
        model('gpt-5.6-terra'),
        model('gpt-6-luna'),
        model('gpt-5.6-luna'),
        model('gpt-99'),
        model('gpt-99-sol-preview'),
      ],
      nextCursor: null,
      extraField: 'future catalog metadata',
    });

    const catalog = await readCodexModelCatalog(transport(rpc));

    expect(catalog).toMatchObject({
      kind: 'listed',
      newestBySize: { astra: 'gpt-6-astra', sol: 'gpt-6.10-sol', terra: 'gpt-5.6-terra', luna: 'gpt-6-luna' },
    });
  });

  it('excludes hidden and upgrade-flagged models from size selection', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        model('gpt-6-sol'),
        model('gpt-7-sol', { hidden: true }),
        model('gpt-8-sol', { upgrade: 'gpt-6-sol' }),
        model('gpt-6-astra', { hidden: true }),
      ],
      nextCursor: null,
    });

    const catalog = await readCodexModelCatalog(transport(rpc));
    expect(catalog.kind).toBe('listed');
    if (catalog.kind !== 'listed') throw new Error(catalog.reason);
    expect(catalog.newestBySize).toEqual({ sol: 'gpt-6-sol' });
  });

  it('follows nextCursor and selects from all pages', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [model('gpt-6-sol')], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ data: [model('gpt-6.1-sol'), model('gpt-6-astra')], nextCursor: null });

    const catalog = await readCodexModelCatalog(transport(rpc));

    expect(catalog).toMatchObject({ kind: 'listed', newestBySize: { sol: 'gpt-6.1-sol', astra: 'gpt-6-astra' } });
    expect(rpc.mock.calls).toEqual([
      ['model/list', { cursor: null, limit: 100, includeHidden: true }],
      ['model/list', { cursor: 'page-2', limit: 100, includeHidden: true }],
    ]);
  });

  it('returns unavailable when an older app-server rejects model/list', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('-32600: Invalid request: unknown variant model/list'));

    expect(await readCodexModelCatalog(transport(rpc))).toEqual({
      kind: 'unavailable',
      reason: 'model/list RPC failed: -32600: Invalid request: unknown variant model/list',
    });
  });

  it('skips a malformed entry while retaining eligible models from the same page', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [model('gpt-6-sol'), { ...model('gpt-7-sol'), supportedReasoningEfforts: 'ultra' }, model('gpt-6.1-sol')],
      nextCursor: null,
    });

    expect(await readCodexModelCatalog(transport(rpc))).toMatchObject({
      kind: 'listed',
      newestBySize: { sol: 'gpt-6.1-sol' },
      skippedEntries: 1,
    });
  });

  it('stops at the first repeated cursor instead of fetching the same page again', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [model('gpt-6-sol')], nextCursor: 'repeat' });

    expect(await readCodexModelCatalog(transport(rpc))).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('repeated cursor'),
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('bounds pagination even when every page has a different cursor', async () => {
    let page = 0;
    const rpc = vi.fn().mockImplementation(async () => ({ data: [], nextCursor: String(++page) }));

    expect(await readCodexModelCatalog(transport(rpc))).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('exceeded'),
    });
    expect(rpc).toHaveBeenCalledTimes(100);
  });

  it('reports supported efforts for every listed model, including hidden and upgrade-flagged ones', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        model('gpt-6.1-sol', {
          supportedReasoningEfforts: [
            { reasoningEffort: 'ultra' },
            { reasoningEffort: 'future-effort' },
            { reasoningEffort: 'low' },
          ],
        }),
        model('gpt-6-luna', { supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { reasoningEffort: 'high' }] }),
        model('gpt-5.5', { upgrade: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }),
        model('gpt-7-astra', { hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }),
        model('gpt-6-terra', { supportedReasoningEfforts: [{ reasoningEffort: 'future-effort' }] }),
      ],
      nextCursor: null,
    });

    const catalog = await readCodexModelCatalog(transport(rpc));

    expect(catalog.kind).toBe('listed');
    if (catalog.kind !== 'listed') throw new Error(catalog.reason);
    expect(Object.fromEntries(catalog.supportedEfforts)).toEqual({
      'gpt-6.1-sol': ['ultra', 'future-effort', 'low'],
      'gpt-6-luna': ['max', 'high'],
      'gpt-5.5': ['xhigh'],
      'gpt-7-astra': ['medium'],
      'gpt-6-terra': ['future-effort'],
    });
  });
});

describe('isCodexSizedModel', () => {
  it.each([
    [' SOL ', true],
    [' GPT-6.1-ASTRA ', true],
    ['gpt-5.6', false],
    ['gpt-6-sol-preview', false],
    ['custom-gpt-5.6-sol', false],
  ])('requires a bare size or complete numeric sized slug: %s', (model, expected) => {
    expect(isCodexSizedModel(model)).toBe(expected);
  });
});
