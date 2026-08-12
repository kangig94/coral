import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { zodPersistedParser, zodValueParser } from '#src/providers/binding-parser.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

import { managed, none } from '#src/providers/capability.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import {
  bindingFailure,
  bindingSuccess,
  type ProviderBindingCodec,
  type ProviderBindingResult,
} from '#src/providers/contracts/binding.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { PROVIDER_ARTIFACT_DISCARD_PROTOCOL } from '#src/providers/contract.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const CLAUDE_BINDING_ENVELOPE = {
  provider: 'claude',
  kind: 'profile',
  binding: {
    profile: {
      canonicalLocation: '/accounts/claude-a',
      routing: { kind: 'config-dir', emitConfigDir: true },
    },
    guarantee: 'profile-only',
  },
} as const;

function successfulBinding(result: ProviderBindingResult<BoundProvider>): BoundProvider {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected binding failure: ${result.failure.reason}`);
  return result.value;
}

describe('provider binding registry boundary', () => {
  it('preserves the managed-artifact protocol and action coordinates through binding', async () => {
    const observed: Array<{ actionId: string; payloadHash: string; operation: string }> = [];
    let loseFirstResponse = true;
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'artifact-protocol',
        transport: 'standalone',
        run: async function* () {},
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
      })
        .binding(fixtureProviderBindingCodec('artifact-protocol'))
        .artifacts(
          managed({
            discardArtifacts: async ({ actionId, payloadHash }) => {
              observed.push({ actionId, payloadHash, operation: 'discard' });
              if (loseFirstResponse) {
                loseFirstResponse = false;
                throw new Error('fixture response lost');
              }
              return { kind: 'discarded' };
            },
            reconcileDiscard: async ({ actionId, payloadHash }) => {
              observed.push({ actionId, payloadHash, operation: 'reconcile' });
              return { kind: 'not-applied' };
            },
          }),
        )
        .build(),
    );
    const bound = successfulBinding(
      registry.rehydrateBinding({
        provider: 'artifact-protocol',
        kind: 'profile',
        binding: {
          profile: { canonicalLocation: '/artifact-protocol', routing: {} },
          guarantee: 'profile-only',
        },
      }),
    );
    if (bound.artifacts.kind !== 'managed') throw new Error('Expected managed artifact capability.');
    expect(bound.artifacts.protocol).toBe(PROVIDER_ARTIFACT_DISCARD_PROTOCOL);
    const runtime = new SimulationRuntime();
    const action = {
      handles: ['/tmp/artifact-protocol.jsonl'],
      actionId: 'discard-action',
      payloadHash: 'discard-payload',
      runtime,
    };

    await expect(bound.artifacts.discardArtifacts(action)).rejects.toThrow('fixture response lost');
    await expect(bound.artifacts.reconcileDiscard(action)).resolves.toEqual({ kind: 'not-applied' });
    await expect(bound.artifacts.discardArtifacts(action)).resolves.toEqual({ kind: 'discarded' });
    expect(observed).toEqual([
      { actionId: 'discard-action', payloadHash: 'discard-payload', operation: 'discard' },
      { actionId: 'discard-action', payloadHash: 'discard-payload', operation: 'reconcile' },
      { actionId: 'discard-action', payloadHash: 'discard-payload', operation: 'discard' },
    ]);
  });

  it('retains each built-in provider continuity decoder on the bound authority', () => {
    const registry = createBuiltInProviderRegistry();
    const claude = successfulBinding(registry.rehydrateBinding(CLAUDE_BINDING_ENVELOPE));
    const codex = successfulBinding(registry.rehydrateBinding(TEST_CODEX_BINDING));

    expect(claude.decodeContinuity(null)).toEqual({ ok: true, value: undefined });
    expect(claude.decodeContinuity({ brokerSessionKey: 'broker-1', brokerTurnId: 'turn-1' })).toEqual({
      ok: true,
      value: { brokerSessionKey: 'broker-1', brokerTurnId: 'turn-1' },
    });
    expect(claude.decodeContinuity({})).toEqual({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'claude' },
    });
    expect(codex.decodeContinuity({ threadId: 'thread-1' })).toEqual({
      ok: true,
      value: { threadId: 'thread-1' },
    });
    expect(codex.decodeContinuity({ threadId: 'thread-1', attacker: true })).toEqual({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'codex' },
    });
  });

  it('rejects provider-produced recovery continuity before it reaches durable state', async () => {
    const codec = {
      ...fixtureProviderBindingCodec('strict-recovery'),
      persistedContinuity: zodPersistedParser(() => z.object({ token: z.string().min(1) }).strict()),
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'strict-recovery',
        transport: 'standalone',
        run: async function* () {},
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
        recovery: {
          finalizeInterrupted: () => ({ kind: 'preserve', providerContinuity: { unknown: true } }) as never,
          finalizeFromArtifacts: async () =>
            ({
              terminal: {
                kind: 'terminal',
                terminal: { content: '', durationMs: 0, outcome: { kind: 'completed' } },
                diagnostics: {},
              },
              continuity: {
                conversationRef: null,
                resumable: false,
                providerContinuity: { unknown: true },
              },
            }) as never,
        },
      })
        .binding(codec)
        .artifacts(none('fixture'))
        .build(),
    );
    const provider = successfulBinding(
      registry.rehydrateBinding({
        provider: 'strict-recovery',
        kind: 'profile',
        binding: {
          profile: { canonicalLocation: '/strict-recovery', routing: {} },
          guarantee: 'profile-only',
        },
      }),
    );

    expect(() => provider.recovery?.finalizeInterrupted({ resumable: false }, undefined, {})).toThrow(
      'invalid recovery continuity mutation',
    );
    await expect(
      provider.recovery?.finalizeFromArtifacts({
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        exitCode: 0,
        signal: null,
        durationMs: 0,
        storage: {
          readFileSync: () => '',
          existsSync: () => false,
          readdirSync: () => [],
          statSync: () => ({ size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true }),
        } as never,
      }),
    ).rejects.toThrow('invalid artifact recovery continuity');
  });

  it('rehydrates a provider-private binding without exposing its typed value', () => {
    const registry = createBuiltInProviderRegistry();

    const binding = successfulBinding(registry.rehydrateBinding(CLAUDE_BINDING_ENVELOPE));

    expect(binding.name).toBe('claude');
    expect(binding.present()).toBe('Claude credential profile');
    expect(binding.present()).not.toContain('/accounts/claude-a');
    expect(Object.isFrozen(binding)).toBe(true);
    expect(binding).not.toHaveProperty('access');
    const execution = binding.prepareExecution({
      request: {
        action: 'exec',
        sessionId: 'session-a',
        prompt: 'test',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {},
      },
      baseEnv: {},
      storage: { existsSync: () => false },
      platform: 'linux',
    });
    expect(execution.kind).toBe('app-server');
    expect(execution).not.toHaveProperty('prepareCliRequest');
    expect(binding.compareIdentity(binding.envelope)).toEqual({ ok: true, value: true });
    expectTypeOf(binding).not.toHaveProperty('profile');
    expectTypeOf(binding).not.toHaveProperty('subject');
    expectTypeOf(binding).not.toHaveProperty('access');
  });

  it('rejects unknown providers, foreign payloads, and mismatched binding kinds', () => {
    const registry = createBuiltInProviderRegistry();

    expect(registry.rehydrateBinding({ ...CLAUDE_BINDING_ENVELOPE, provider: 'foreign' })).toEqual({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'foreign' },
    });
    expect(
      registry.rehydrateBinding({
        ...CLAUDE_BINDING_ENVELOPE,
        binding: {
          profile: { canonicalLocation: '/accounts/codex-a', routing: { kind: 'home' } },
          guarantee: 'profile-only',
        },
      }),
    ).toEqual({ ok: false, failure: { reason: 'invalid-persisted-binding', provider: 'claude' } });
    expect(registry.rehydrateBinding({ ...CLAUDE_BINDING_ENVELOPE, kind: 'account' })).toEqual({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'claude' },
    });
  });

  it('renders an unregistered provider with the registered choices and configuration docs', () => {
    const registry = createBuiltInProviderRegistry();

    expect(
      registry.renderBindingFailure({
        reason: 'unsupported-selection',
        provider: 'foreign',
        selector: 'foreign',
      }),
    ).toBe(
      "Provider 'foreign' is not registered. Choose one of: claude, codex. See docs/configuration.md#multi-account-provider-routing.",
    );
  });

  it('owns selection validation and safe selector labels', () => {
    const registry = createBuiltInProviderRegistry();

    expect(
      registry.selectorLabel('claude', {
        kind: 'config-dir',
        configDir: '/accounts/claude-a',
        emitConfigDir: true,
      }),
    ).toBe('Claude config directory');
    expect(() => registry.selectorLabel('claude', { kind: 'unsupported' })).toThrow();
    expect(registry.selectorLabel('codex', { kind: 'home', home: '/accounts/codex-a' })).toBe('Codex home');
    expect(() => registry.selectorLabel('codex', { kind: 'home', home: 'relative' })).toThrow();
    expect(() => registry.selectorLabel('foreign', {})).toThrow('unsupported_provider_selection: foreign');
  });

  it('decodes complete scopes through provider-owned profile codecs before persistence', () => {
    const registry = createBuiltInProviderRegistry();

    expect(registry.decodeScope(TEST_PROVIDER_SCOPE)).toEqual({ ok: true, value: TEST_PROVIDER_SCOPE });
    expect(
      registry.decodeScope({
        ...TEST_PROVIDER_SCOPE,
        profiles: [...TEST_PROVIDER_SCOPE.profiles, TEST_PROVIDER_SCOPE.profiles[0]],
      }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'unsupported-selection',
        provider: 'codex',
        selector: 'duplicate codex credential profile',
      },
    });
    expect(
      registry.decodeScope({
        origin: 'caller',
        profiles: [
          {
            provider: 'codex',
            profile: {
              canonicalLocation: '/accounts/codex-a',
              routing: { kind: 'home' },
              accessToken: 'must-not-persist',
            },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'profile-unavailable',
        provider: 'codex',
        selector: 'codex credential profile',
      },
    });
    expect(
      registry.decodeScope({
        origin: 'caller',
        profiles: [{ provider: 'foreign', profile: {} }],
      }),
    ).toEqual({
      ok: false,
      failure: { reason: 'unsupported-selection', provider: 'foreign', selector: 'foreign' },
    });
    expect(
      registry.decodeScope({
        origin: 'system',
        name: 'invalid-relative-profile',
        profiles: [{ provider: 'codex', profile: { canonicalLocation: 'relative', routing: { kind: 'home' } } }],
      }),
    ).toEqual({
      ok: false,
      failure: {
        reason: 'profile-unavailable',
        provider: 'codex',
        selector: 'codex credential profile',
      },
    });
  });

  it('exports every provider-private persisted component plus the envelope', () => {
    const registry = createBuiltInProviderRegistry();
    expect(registry.sealPersistedCodecComponents().map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.codex.profile',
      'provider.codex.binding',
      'provider.codex.continuity',
      'provider.claude.profile',
      'provider.claude.binding',
      'provider.claude.continuity',
    ]);
  });

  it('rehydrates account bindings while keeping profile and subject private', () => {
    const createSelectionSchema = () => z.object({ account: z.string().min(1) }).strict();
    const createProfileSchema = () =>
      z
        .object({ canonicalLocation: z.string().min(1), routing: z.object({ kind: z.literal('fixture') }).strict() })
        .strict();
    const createSubjectSchema = () => z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict();
    const createBindingSchema = () =>
      z.object({ profile: createProfileSchema(), subject: createSubjectSchema() }).strict();
    type Selection = z.infer<ReturnType<typeof createSelectionSchema>>;
    type Profile = z.infer<ReturnType<typeof createProfileSchema>>;
    type Subject = z.infer<ReturnType<typeof createSubjectSchema>>;
    const codec: ProviderBindingCodec<Selection, Profile, Subject> = {
      parseSelection: zodValueParser(createSelectionSchema),
      persistedProfile: zodPersistedParser(createProfileSchema),
      persistedContinuity: zodPersistedParser(() => z.record(z.string(), z.unknown())),
      persistedBinding: zodPersistedParser(createBindingSchema),
      bindingKind: 'account',
      captureSelection: () => bindingSuccess({ account: 'fixture' }),
      async canonicalizeProfile() {
        return bindingSuccess({ canonicalLocation: '/accounts/private', routing: { kind: 'fixture' } });
      },
      selectorLabel: () => 'fixture account',
      renderFailure: (failure) => failure.reason,
      async bindProfile(profile) {
        return bindingSuccess({
          profile,
          subject: { issuer: 'issuer-private', subject: 'subject-private' },
        });
      },
      async readiness(_binding, use) {
        return bindingSuccess({ ready: true, use });
      },
      access: (binding) => ({
        version: 1,
        provider: 'codex',
        kind: 'home',
        home: binding.profile.canonicalLocation,
      }),
      compareBinding: (left, right) =>
        left.profile.canonicalLocation === right.profile.canonicalLocation &&
        left.subject.issuer === right.subject.issuer &&
        left.subject.subject === right.subject.subject
          ? bindingSuccess(true)
          : bindingFailure({ reason: 'subject-mismatch', provider: 'account-fixture' }),
      presentBinding: () => 'verified fixture account',
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'account-fixture',
        transport: 'standalone',
        run: async function* () {},
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
      })
        .binding(codec)
        .artifacts(none('fixture'))
        .build(),
    );

    const raw = {
      provider: 'account-fixture',
      kind: 'account',
      binding: {
        profile: { canonicalLocation: '/accounts/private', routing: { kind: 'fixture' } },
        subject: { issuer: 'issuer-private', subject: 'subject-private' },
      },
    } as const;
    const rehydrated = successfulBinding(registry.rehydrateBinding(raw));

    expect(rehydrated.envelope.kind).toBe('account');
    expect(rehydrated.present()).toBe('verified fixture account');
    expect(rehydrated.present()).not.toContain('private');
    expect(
      registry.rehydrateBinding({
        ...raw,
        binding: { ...raw.binding, subject: { issuer: 'issuer-private' } },
      }),
    ).toEqual({ ok: false, failure: { reason: 'invalid-persisted-binding', provider: 'account-fixture' } });
    expect(registry.rehydrateBinding({ ...raw, kind: 'profile' })).toEqual({
      ok: false,
      failure: { reason: 'invalid-persisted-binding', provider: 'account-fixture' },
    });
    expect(registry.sealPersistedCodecComponents().map((entry) => entry.name)).toContain(
      'provider.account-fixture.binding',
    );
  });

  it('rejects contradictory Claude routing profiles', () => {
    const registry = createBuiltInProviderRegistry();

    expect(
      registry.rehydrateBinding({
        ...CLAUDE_BINDING_ENVELOPE,
        binding: {
          profile: {
            canonicalLocation: '/accounts/claude-a',
            routing: { kind: 'unsupported', emitConfigDir: true },
          },
          guarantee: 'profile-only',
        },
      }),
    ).toEqual({ ok: false, failure: { reason: 'invalid-persisted-binding', provider: 'claude' } });
  });

  it('preserves codec method receivers inside the erased boundary', () => {
    const base = fixtureProviderBindingCodec('receiver');
    const codec = {
      ...base,
      label: 'receiver-safe',
      selectorLabel(this: { label: string }) {
        return this.label;
      },
      presentBinding(this: { label: string }) {
        return this.label;
      },
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({
        name: 'receiver',
        transport: 'standalone',
        run: async function* () {},
        prepareExecutionPlan: () => ({
          plan: { host: undefined, session: undefined, turn: undefined },
          prepareCliRequest: (request) => request,
        }),
      })
        .binding(codec)
        .artifacts(none('receiver'))
        .build(),
    );

    expect(registry.selectorLabel('receiver', { key: 'selection' })).toBe('receiver-safe');
    expect(
      successfulBinding(
        registry.rehydrateBinding({
          provider: 'receiver',
          kind: 'profile',
          binding: {
            profile: { canonicalLocation: '/accounts/receiver', routing: {} },
            guarantee: 'profile-only',
          },
        }),
      ).present(),
    ).toBe('receiver-safe');
  });
});
