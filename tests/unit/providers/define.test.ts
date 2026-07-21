import { describe, expect, it } from 'vitest';

import { managed, none } from '#src/providers/capability.js';
import type { ProviderManagedArtifactCapability, ProviderSpec } from '#src/providers/contract.js';
import { defineProvider } from '#src/providers/registry.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';

const run: ProviderSpec['run'] = async function* () {
  yield {
    kind: 'terminal',
    terminal: {
      content: 'ok',
      outcome: { kind: 'completed' },
    },
    diagnostics: {},
  };
};

function compileTimeAssertions(): void {
  // @ts-expect-error artifacts is unavailable until binding(...) declares the provider-owned codec.
  defineProvider({ name: 'missing-binding', run }).artifacts(none('unreachable'));
  // @ts-expect-error build is unavailable until artifacts(...) declares the artifact capability.
  defineProvider({ name: 'missing-artifacts', run }).binding(fixtureProviderBindingCodec('missing-artifacts')).build();

  const registry = new ProviderRegistry();
  // @ts-expect-error register accepts only branded ProviderDefinition, not raw ProviderSpec values.
  registry.register({ name: 'raw-provider-spec', run } as ProviderSpec);
}

void compileTimeAssertions;

describe('defineProvider', () => {
  it('builds a branded provider definition after artifact capability declaration', () => {
    const definition = defineProvider({ name: 'fake', run })
      .binding(fixtureProviderBindingCodec('fake'))
      .artifacts(none('fake provider emits no provider artifacts'))
      .build();

    expect(definition.name).toBe('fake');
    expect(definition.run).toBe(run);
    // @ts-expect-error provider-private codecs are unavailable from the public definition/catalog view.
    void definition.binding;
    expect(definition.artifacts).toEqual({
      kind: 'none',
      reason: 'fake provider emits no provider artifacts',
    });
  });

  it('preserves managed artifact capabilities on the provider definition', () => {
    const discardArtifacts: ProviderManagedArtifactCapability['discardArtifacts'] = async ({ handles }) => ({
      kind: handles.length === 0 ? ('skipped_no_handles' as const) : ('discarded' as const),
    });
    const definition = defineProvider({ name: 'managed-fake', run })
      .binding(fixtureProviderBindingCodec('managed-fake'))
      .artifacts(
        managed({
          discardArtifacts,
        }),
      )
      .build();

    expect(definition.artifacts.kind).toBe('managed');
    if (definition.artifacts.kind === 'managed') {
      expect(definition.artifacts.discardArtifacts).toBe(discardArtifacts);
    }
  });
});
