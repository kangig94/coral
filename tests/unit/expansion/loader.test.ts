import { describe, expect, it } from 'vitest';

import { loadExpansions } from '#src/expansion/loader.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

function toDataModule(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

describe('loadExpansions', () => {
  it('loads expansions sequentially and returns scopes in manifest order', async () => {
    const { makeHost } = createTestRuntime();
    const seen: string[] = [];
    (globalThis as { __expansionLoads?: string[] }).__expansionLoads = seen;

    const scopes = await loadExpansions(makeHost, [
      {
        id: 'alpha',
        version: '0.0.0',
        specifier: toDataModule('export default async (host) => { globalThis.__expansionLoads.push(host.id); }'),
        tier: 'installed',
        description: 'alpha',
      },
      {
        id: 'beta',
        version: '0.0.0',
        specifier: toDataModule('export default async (host) => { globalThis.__expansionLoads.push(host.id); }'),
        tier: 'installed',
        description: 'beta',
      },
    ]);

    expect(seen).toEqual(['alpha', 'beta']);
    expect(scopes).toHaveLength(2);
  });

  it('disposes earlier scopes when a later expansion fails', async () => {
    const { makeHost } = createTestRuntime();
    const vector = createRuntimeBinding<string>('kb.vector');
    const fts = createRuntimeBinding<string>('kb.fts');
    (globalThis as { __vectorBinding?: typeof vector; __ftsBinding?: typeof fts }).__vectorBinding = vector;
    (globalThis as { __vectorBinding?: typeof vector; __ftsBinding?: typeof fts }).__ftsBinding = fts;

    await expect(
      loadExpansions(makeHost, [
        {
          id: 'alpha',
          version: '0.0.0',
          specifier: toDataModule("export default (host) => { host.bind(globalThis.__vectorBinding, 'needle'); }"),
          tier: 'installed',
          description: 'alpha',
        },
        {
          id: 'beta',
          version: '0.0.0',
          specifier: toDataModule(
            "export default (host) => { host.bind(globalThis.__ftsBinding, 'needle-fts'); throw new Error('boom'); }",
          ),
          tier: 'installed',
          description: 'beta',
        },
      ]),
    ).rejects.toThrow('boom');

    expect(() => vector.read()).toThrowError(CoralSetupError);
    expect(() => fts.read()).toThrowError(CoralSetupError);
    expect(vector.heldBy).toBeUndefined();
    expect(fts.heldBy).toBeUndefined();
  });
});
