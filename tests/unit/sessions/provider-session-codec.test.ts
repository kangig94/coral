import { describe, expect, it } from 'vitest';

import { providerSessionSchema } from '#src/sessions/entry.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';

const CURRENT_PROVIDER_SESSION = {
  sessionId: 'session-current-codec',
  binding: TEST_CODEX_BINDING,
  name: 'current codec',
  state: 'ready',
  retention: 'retain',
  artifactHandles: [],
  retentionDiscard: { attempts: [] },
  providerContinuity: null,
  cwd: '/tmp/project',
  projectRoot: '/tmp/project',
  backendNamespace: 'test',
  controllerProfile: {
    owner: 'team-a',
    effort: 'high',
    claudeModelCap: 'sonnet',
  },
  createdAt: '2026-07-22T00:00:00.000Z',
  lastUsedAt: '2026-07-22T00:00:00.000Z',
  version: 1,
} as const;

describe('ProviderSession persisted codec', () => {
  it('accepts the complete current shape without normalization', () => {
    expect(providerSessionSchema.parse(CURRENT_PROVIDER_SESSION)).toEqual(CURRENT_PROVIDER_SESSION);
  });

  it.each(['retention', 'artifactHandles', 'retentionDiscard'] as const)(
    'rejects a current ProviderSession missing %s',
    (field) => {
      const incomplete = { ...CURRENT_PROVIDER_SESSION } as Record<string, unknown>;
      delete incomplete[field];

      expect(providerSessionSchema.safeParse(incomplete).success).toBe(false);
    },
  );

  it('rejects missing retention-discard attempts and unknown fields at every object boundary', () => {
    expect(
      providerSessionSchema.safeParse({
        ...CURRENT_PROVIDER_SESSION,
        retentionDiscard: {},
      }).success,
    ).toBe(false);
    expect(
      providerSessionSchema.safeParse({
        ...CURRENT_PROVIDER_SESSION,
        legacyProvider: 'codex',
      }).success,
    ).toBe(false);
    expect(
      providerSessionSchema.safeParse({
        ...CURRENT_PROVIDER_SESSION,
        controllerProfile: {
          ...CURRENT_PROVIDER_SESSION.controllerProfile,
          claudeTransport: 'print',
        },
      }).success,
    ).toBe(false);
  });
});
