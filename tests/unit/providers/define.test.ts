import { describe, expect, it } from 'vitest';

import { managed, none } from '#src/providers/capability.js';
import type { ProviderSpec } from '#src/providers/contract.js';
import { defineProvider } from '#src/providers/define.js';
import { ProviderRegistry } from '#src/providers/registry.js';

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
  // @ts-expect-error build is unavailable until artifacts(...) declares the artifact capability.
  defineProvider({ name: 'missing-artifacts', run }).build();

  const registry = new ProviderRegistry();
  // @ts-expect-error register accepts only branded ProviderDefinition, not raw ProviderSpec values.
  registry.register({ name: 'raw-provider-spec', run } as ProviderSpec);
}

void compileTimeAssertions;

describe('defineProvider', () => {
  it('builds a branded provider definition after artifact capability declaration', () => {
    const definition = defineProvider({ name: 'fake', run })
      .artifacts(none('fake provider emits no provider artifacts'))
      .build();

    expect(definition.name).toBe('fake');
    expect(definition.run).toBe(run);
    expect(definition.artifacts).toEqual({
      kind: 'none',
      reason: 'fake provider emits no provider artifacts',
    });
  });

  it('preserves managed artifact capabilities on the provider definition', () => {
    const discardArtifacts = async (handles: readonly string[]) => ({
      kind: handles.length === 0 ? ('skipped_no_handles' as const) : ('discarded' as const),
    });
    const definition = defineProvider({ name: 'managed-fake', run })
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
