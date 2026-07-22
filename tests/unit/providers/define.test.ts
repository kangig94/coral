import { describe, expect, it } from 'vitest';

import { managed, none } from '#src/providers/capability.js';
import type { ProviderImplementation, ProviderManagedArtifactCapability } from '#src/providers/contract.js';
import { defineProvider } from '#src/providers/registry.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import type { ProviderExecutionPlan } from '#src/providers/execution-plan.js';

type EmptyPlan = ProviderExecutionPlan<undefined, undefined, undefined>;

const run: ProviderImplementation<EmptyPlan>['run'] = async function* () {
  yield {
    kind: 'terminal',
    terminal: {
      content: 'ok',
      durationMs: 0,
      outcome: { kind: 'completed' },
    },
    diagnostics: {},
  };
};

const prepareExecutionPlan: ProviderImplementation<EmptyPlan>['prepareExecutionPlan'] = () => ({
  plan: { host: undefined, session: undefined, turn: undefined },
  prepareCliRequest: (request) => request,
});

function compileTimeAssertions(): void {
  // @ts-expect-error artifacts is unavailable until binding(...) declares the provider-owned codec.
  defineProvider({ name: 'missing-binding', run, prepareExecutionPlan }).artifacts(none('unreachable'));
  const missingArtifacts = defineProvider({ name: 'missing-artifacts', run, prepareExecutionPlan }).binding(
    fixtureProviderBindingCodec('missing-artifacts'),
  );
  // @ts-expect-error build is unavailable until artifacts(...) declares the artifact capability.
  missingArtifacts.build();

  const registry = new ProviderRegistry();
  // @ts-expect-error register accepts only branded ProviderDefinition, not raw implementation values.
  registry.register({ name: 'raw-provider-spec', run, prepareExecutionPlan });
}

void compileTimeAssertions;

describe('defineProvider', () => {
  it('builds a branded provider definition after artifact capability declaration', () => {
    const definition = defineProvider({ name: 'fake', run, prepareExecutionPlan })
      .binding(fixtureProviderBindingCodec('fake'))
      .artifacts(none('fake provider emits no provider artifacts'))
      .build();

    expect(definition).toEqual({ name: 'fake' });
    expect(definition).not.toHaveProperty('run');
    expect(definition).not.toHaveProperty('preflight');
    expect(definition).not.toHaveProperty('appServer');
    expect(definition).not.toHaveProperty('recovery');
    expect(definition).not.toHaveProperty('artifacts');
    // @ts-expect-error provider-private codecs are unavailable from the public definition/catalog view.
    void definition.binding;
  });

  it('keeps managed artifact capabilities out of the provider definition', () => {
    const discardArtifacts: ProviderManagedArtifactCapability['discardArtifacts'] = async ({ handles }) => ({
      kind: handles.length === 0 ? ('skipped_no_handles' as const) : ('discarded' as const),
    });
    const definition = defineProvider({ name: 'managed-fake', run, prepareExecutionPlan })
      .binding(fixtureProviderBindingCodec('managed-fake'))
      .artifacts(
        managed({
          discardArtifacts,
        }),
      )
      .build();

    expect(definition).toEqual({ name: 'managed-fake' });
    expect(definition).not.toHaveProperty('artifacts');
  });
});
