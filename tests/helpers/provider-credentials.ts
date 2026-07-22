import type { ProviderScope } from '#src/infra/provider-scope.js';
import { buildClaudeExecutionPlan, type ClaudeCredentialSource } from '#src/providers/claude/execution-plan.js';
import { buildCodexExecutionPlan, type CodexCredentialSource } from '#src/providers/codex/execution-plan.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';
import type { ProviderBindingEnvelope } from '#src/infra/provider-binding-envelope.js';

export const TEST_CODEX_SOURCE = {
  home: '/home/user/.codex',
} as const satisfies CodexCredentialSource;

export const TEST_CLAUDE_SOURCE = {
  configDir: '/home/user/.claude',
  projectsRoot: '/home/user/.claude/projects',
  routing: { kind: 'config-dir' },
} as const satisfies ClaudeCredentialSource;

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

const TEST_EXECUTION_REQUEST = {
  action: 'exec',
  sessionId: 'test-session',
  prompt: 'test',
  cwd: '/workspace',
  bypassPermissions: false,
  coralEnv: {},
} as const;

const TEST_CODEX_PREPARED = buildCodexExecutionPlan({
  source: TEST_CODEX_SOURCE,
  request: TEST_EXECUTION_REQUEST,
  baseEnv: {},
  platform: 'linux',
});
export const TEST_CODEX_PLAN = TEST_CODEX_PREPARED.plan;
export const TEST_CODEX_APP_SERVER_LAUNCH = {
  host: codexAppServerLifecycle.compileStableHost(TEST_CODEX_PREPARED.plan.host),
  turnEnv: TEST_CODEX_PREPARED.appServerTurnEnv,
};

const TEST_CLAUDE_PREPARED = buildClaudeExecutionPlan({
  source: TEST_CLAUDE_SOURCE,
  request: TEST_EXECUTION_REQUEST,
  baseEnv: {},
  storage: { existsSync: () => false },
  platform: 'linux',
});
export const TEST_CLAUDE_PLAN = TEST_CLAUDE_PREPARED.plan;
export const TEST_CLAUDE_APP_SERVER_LAUNCH = {
  host: claudeAppServerLifecycle.compileStableHost(TEST_CLAUDE_PREPARED.plan.host),
  turnEnv: TEST_CLAUDE_PREPARED.appServerTurnEnv,
};

export function prepareTestCodexAppServer(
  request: { readonly cwd: string; readonly coralEnv?: Record<string, string> },
  persistedContinuity?: Record<string, unknown>,
) {
  const prepared = buildCodexExecutionPlan({
    source: TEST_CODEX_SOURCE,
    request: {
      ...TEST_EXECUTION_REQUEST,
      cwd: request.cwd,
      coralEnv: request.coralEnv ?? {},
    },
    persistedContinuity,
    baseEnv: {},
    platform: 'linux',
  });
  return codexAppServerLifecycle.compileStableHost(prepared.plan.host);
}
