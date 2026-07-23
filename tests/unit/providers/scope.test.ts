import { describe, expect, it } from 'vitest';

import { providerScopeSchema } from '#src/infra/provider-scope.js';

const profile = { provider: 'codex', profile: { canonicalLocation: '/accounts/codex-a' } } as const;

describe('providerScopeSchema', () => {
  it('accepts explicit caller and named system scopes', () => {
    expect(providerScopeSchema.parse({ origin: 'caller', profiles: [profile] })).toEqual({
      origin: 'caller',
      profiles: [profile],
    });
    expect(providerScopeSchema.parse({ origin: 'system', name: 'maintenance', profiles: [profile] })).toEqual({
      origin: 'system',
      name: 'maintenance',
      profiles: [profile],
    });
  });

  it('rejects ambiguous origins, empty system names, foreign fields, and non-JSON profiles', () => {
    expect(() => providerScopeSchema.parse({ profiles: [] })).toThrow();
    expect(() => providerScopeSchema.parse({ origin: 'system', name: '', profiles: [] })).toThrow();
    expect(() => providerScopeSchema.parse({ origin: 'caller', name: 'not-allowed', profiles: [] })).toThrow();
    expect(() =>
      providerScopeSchema.parse({ origin: 'caller', profiles: [{ provider: 'codex', profile: undefined }] }),
    ).toThrow();
    expect(() =>
      providerScopeSchema.parse({ origin: 'caller', profiles: [{ provider: 'codex', profile: Number.NaN }] }),
    ).toThrow();
  });
});
