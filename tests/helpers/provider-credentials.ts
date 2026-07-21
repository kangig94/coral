import type { ProviderCredentialSourceRef } from '#src/infra/provider-credential-sources.js';
import type { ProviderScope } from '#src/infra/provider-scope.js';
import type { ProviderExecutionContext } from '#src/providers/contract.js';
import type { ProviderBindingEnvelope } from '#src/infra/provider-binding-envelope.js';

export const TEST_CODEX_SOURCE = {
  version: 1,
  provider: 'codex',
  kind: 'home',
  home: '/home/user/.codex',
} as const satisfies ProviderCredentialSourceRef;

export const TEST_CLAUDE_SOURCE = {
  version: 1,
  provider: 'claude',
  kind: 'config-dir',
  configDir: '/home/user/.claude',
  projectsRoot: '/home/user/.claude/projects',
  emitConfigDir: true,
} as const satisfies ProviderCredentialSourceRef;

export const TEST_CODEX_BINDING = {
  provider: 'codex',
  kind: 'account',
  binding: {
    profile: { canonicalLocation: TEST_CODEX_SOURCE.home, routing: { kind: 'home' } },
    subject: { issuer: 'https://api.openai.com/chatgpt-account', subject: 'test-account' },
  },
} as const satisfies ProviderBindingEnvelope;

export const TEST_CLAUDE_BINDING = {
  provider: 'claude',
  kind: 'profile',
  binding: {
    profile: {
      canonicalLocation: TEST_CLAUDE_SOURCE.configDir,
      routing: { kind: 'config-dir', emitConfigDir: true },
    },
    guarantee: 'profile-only',
  },
} as const satisfies ProviderBindingEnvelope;

export const TEST_PROVIDER_SCOPE = {
  origin: 'caller',
  profiles: [
    {
      provider: 'codex',
      profile: { canonicalLocation: TEST_CODEX_SOURCE.home, routing: { kind: 'home' } },
    },
    {
      provider: 'claude',
      profile: {
        canonicalLocation: TEST_CLAUDE_SOURCE.configDir,
        routing: { kind: 'config-dir', emitConfigDir: true },
      },
    },
  ],
} as const satisfies ProviderScope;

export const TEST_PROVIDER_SCOPE_INPUT = {
  origin: 'caller',
  profiles: [...TEST_PROVIDER_SCOPE.profiles],
} as const satisfies ProviderScope;

export const TEST_CODEX_SCOPE = {
  origin: 'caller',
  profiles: [TEST_PROVIDER_SCOPE.profiles[0]],
} as const satisfies ProviderScope;

export const TEST_CODEX_SCOPE_INPUT = {
  origin: 'caller',
  profiles: [...TEST_CODEX_SCOPE.profiles],
} as const satisfies ProviderScope;

export const TEST_SYSTEM_PROVIDER_SCOPE = {
  origin: 'system',
  name: 'test-system',
  profiles: [...TEST_PROVIDER_SCOPE.profiles],
} as const satisfies ProviderScope;

export function withTestProfileLocation(
  scope: ProviderScope,
  provider: string,
  canonicalLocation: string,
): ProviderScope {
  return {
    ...scope,
    profiles: scope.profiles.map((entry) =>
      entry.provider === provider
        ? { ...entry, profile: { ...(entry.profile as Record<string, unknown>), canonicalLocation } }
        : entry,
    ),
  } as ProviderScope;
}

export function withTestBindingLocation(
  envelope: ProviderBindingEnvelope,
  canonicalLocation: string,
): ProviderBindingEnvelope {
  const binding = envelope.binding as Record<string, unknown>;
  const profile = binding.profile as Record<string, unknown>;
  return { ...envelope, binding: { ...binding, profile: { ...profile, canonicalLocation } } };
}

export const TEST_CODEX_CONTEXT = {
  provider: 'codex',
  source: TEST_CODEX_SOURCE,
  appServerEnv: { CODEX_HOME: TEST_CODEX_SOURCE.home },
} as const satisfies ProviderExecutionContext;

export const TEST_CLAUDE_CONTEXT = {
  provider: 'claude',
  source: TEST_CLAUDE_SOURCE,
  brokerEnv: {},
  controllerEnv: { CLAUDE_CONFIG_DIR: TEST_CLAUDE_SOURCE.configDir },
  projectsRoot: TEST_CLAUDE_SOURCE.projectsRoot,
} as const satisfies ProviderExecutionContext;
