import { describe, expect, it } from 'vitest';

import { loadExpansions } from '#src/expansion/loader.js';
import { KB_FTS_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
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
    const { kb, makeHost } = createTestRuntime();

    await expect(
      loadExpansions(makeHost, [
        {
          id: 'alpha',
          version: '0.0.0',
          specifier: toDataModule("export default (host) => { host.bind('kb.vector', 'needle'); }"),
          tier: 'installed',
          description: 'alpha',
          fills: [KB_VECTOR_CAPABILITY],
        },
        {
          id: 'beta',
          version: '0.0.0',
          specifier: toDataModule(
            "export default (host) => { host.bind('kb.fts', 'needle-fts'); throw new Error('boom'); }",
          ),
          tier: 'installed',
          description: 'beta',
          fills: [KB_FTS_CAPABILITY],
        },
      ]),
    ).rejects.toThrow('boom');

    expect(kb.capabilityRegistry.runtimeView().status(KB_VECTOR_CAPABILITY)?.heldBy).toBeUndefined();
    expect(kb.capabilityRegistry.runtimeView().status(KB_FTS_CAPABILITY)?.heldBy).toBeUndefined();
  });
});
