import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { none } from '#src/providers/capability.js';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import type { ProviderBindingCodec } from '#src/providers/contracts/binding.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';

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

describe('provider binding registry boundary', () => {
  it('rehydrates a provider-private binding without exposing its typed value', () => {
    const registry = createBuiltInProviderRegistry();

    const binding = registry.rehydrateBinding(CLAUDE_BINDING_ENVELOPE);

    expect(binding.provider).toBe('claude');
    expect(binding.present()).toBe('Claude credential profile');
    expect(binding.present()).not.toContain('/accounts/claude-a');
    expect(Object.keys(binding).sort()).toEqual(['envelope', 'present', 'provider']);
    expectTypeOf(binding).not.toHaveProperty('profile');
    expectTypeOf(binding).not.toHaveProperty('subject');
  });

  it('rejects unknown providers, foreign payloads, and mismatched binding kinds', () => {
    const registry = createBuiltInProviderRegistry();

    expect(() => registry.rehydrateBinding({ ...CLAUDE_BINDING_ENVELOPE, provider: 'foreign' })).toThrow(
      "provider 'foreign' is not registered",
    );
    expect(() =>
      registry.rehydrateBinding({
        ...CLAUDE_BINDING_ENVELOPE,
        binding: {
          profile: { canonicalLocation: '/accounts/codex-a', routing: { kind: 'home' } },
          guarantee: 'profile-only',
        },
      }),
    ).toThrow();
    expect(() => registry.rehydrateBinding({ ...CLAUDE_BINDING_ENVELOPE, kind: 'account' })).toThrow(
      'expected claude/profile',
    );
  });

  it('owns selection validation and safe selector labels', () => {
    const registry = createBuiltInProviderRegistry();

    expect(registry.selectorLabel('claude', { kind: 'ambient' })).toBe('caller-default Claude profile');
    expect(registry.selectorLabel('codex', { kind: 'home', home: '/accounts/codex-a' })).toBe('Codex home');
    expect(() => registry.selectorLabel('codex', { kind: 'home', home: 'relative' })).toThrow();
    expect(() => registry.selectorLabel('foreign', {})).toThrow('unsupported_provider_selection: foreign');
  });

  it('exports one stable persisted component per provider plus the envelope', () => {
    const registry = createBuiltInProviderRegistry();
    expect(registry.sealPersistedBindingCodecComponents().map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.codex.binding',
      'provider.claude.binding',
    ]);
  });

  it('rehydrates account bindings while keeping profile and subject private', () => {
    const selectionSchema = z.object({ account: z.string().min(1) }).strict();
    const profileSchema = z
      .object({ canonicalLocation: z.string().min(1), routing: z.object({ kind: z.literal('fixture') }).strict() })
      .strict();
    const subjectSchema = z.object({ issuer: z.string().min(1), subject: z.string().min(1) }).strict();
    const bindingSchema = z.object({ profile: profileSchema, subject: subjectSchema }).strict();
    const codec: ProviderBindingCodec<
      z.infer<typeof selectionSchema>,
      z.infer<typeof profileSchema>,
      z.infer<typeof subjectSchema>
    > = {
      selectionSchema,
      profileSchema,
      bindingSchema,
      bindingKind: 'account',
      selectorLabel: () => 'fixture account',
      presentBinding: () => 'verified fixture account',
    };
    const registry = new ProviderRegistry();
    registry.register(
      defineProvider({ name: 'account-fixture', run: async function* () {} })
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
    const rehydrated = registry.rehydrateBinding(raw);

    expect(rehydrated.envelope.kind).toBe('account');
    expect(rehydrated.present()).toBe('verified fixture account');
    expect(rehydrated.present()).not.toContain('private');
    expect(() =>
      registry.rehydrateBinding({
        ...raw,
        binding: { ...raw.binding, subject: { issuer: 'issuer-private' } },
      }),
    ).toThrow();
    expect(() => registry.rehydrateBinding({ ...raw, kind: 'profile' })).toThrow(
      'expected account-fixture/account',
    );
    expect(registry.sealPersistedBindingCodecComponents().map((entry) => entry.name)).toContain(
      'provider.account-fixture.binding',
    );
  });

  it('rejects contradictory Claude routing profiles', () => {
    const registry = createBuiltInProviderRegistry();

    expect(() =>
      registry.rehydrateBinding({
        ...CLAUDE_BINDING_ENVELOPE,
        binding: {
          profile: {
            canonicalLocation: '/accounts/claude-a',
            routing: { kind: 'ambient', emitConfigDir: true },
          },
          guarantee: 'profile-only',
        },
      }),
    ).toThrow();
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
      defineProvider({ name: 'receiver', run: async function* () {} })
        .binding(codec)
        .artifacts(none('receiver'))
        .build(),
    );

    expect(registry.selectorLabel('receiver', { key: 'selection' })).toBe('receiver-safe');
    expect(
      registry
        .rehydrateBinding({
          provider: 'receiver',
          kind: 'profile',
          binding: {
            profile: { canonicalLocation: '/accounts/receiver', routing: {} },
            guarantee: 'profile-only',
          },
        })
        .present(),
    ).toBe('receiver-safe');
  });
});
