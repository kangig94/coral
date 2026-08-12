import type { ProviderScope } from '#src/infra/provider-scope.js';
import {
  buildClaudeExecutionPlan,
  claudeBaseLayer,
  claudeBrokerSettingsLayer,
  claudeRoutingLayer,
  type ClaudeProviderAccess,
  type ClaudeExecutionPlan,
} from '#src/providers/claude/execution-plan.js';
import { buildCodexExecutionPlan, type CodexProviderAccess } from '#src/providers/codex/execution-plan.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';
import type { ProviderBindingEnvelope } from '#src/infra/provider-binding-envelope.js';

import { fixtureCanonicalWorkDir } from './canonical-work-dir.js';

export const TEST_CODEX_ACCESS = {
  home: '/home/user/.codex',
} as const satisfies CodexProviderAccess;

export const TEST_CLAUDE_ACCESS = {
  configDir: '/home/user/.claude',
  projectsRoot: '/home/user/.claude/projects',
  routing: { kind: 'config-dir' },
} as const satisfies ClaudeProviderAccess;

export const TEST_CODEX_BINDING = {
  provider: 'codex',
  kind: 'account',
  binding: {
    profile: { canonicalLocation: TEST_CODEX_ACCESS.home, routing: { kind: 'home' } },
    subject: { issuer: 'https://api.openai.com/chatgpt-account', subject: 'test-account' },
  },
} as const satisfies ProviderBindingEnvelope;

export const TEST_CLAUDE_BINDING = {
  provider: 'claude',
  kind: 'profile',
  binding: {
    profile: {
      canonicalLocation: TEST_CLAUDE_ACCESS.configDir,
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
      profile: { canonicalLocation: TEST_CODEX_ACCESS.home, routing: { kind: 'home' } },
    },
    {
      provider: 'claude',
      profile: {
        canonicalLocation: TEST_CLAUDE_ACCESS.configDir,
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
  cwd: fixtureCanonicalWorkDir('/workspace'),
  bypassPermissions: false,
  coralEnv: {},
} as const;

const TEST_CODEX_PREPARED = buildCodexExecutionPlan({
  access: TEST_CODEX_ACCESS,
  hostPlan: codexAppServerLifecycle.planHost({
    purpose: 'execution',
    access: TEST_CODEX_ACCESS,
    request: TEST_EXECUTION_REQUEST,
    baseEnv: {},
    platform: 'linux',
    storage: { existsSync: () => false },
  }),
  request: TEST_EXECUTION_REQUEST,
  baseEnv: {},
  platform: 'linux',
});
export const TEST_CODEX_PLAN = Object.freeze({
  host: codexAppServerLifecycle.planHost({
    purpose: 'execution',
    access: TEST_CODEX_ACCESS,
    request: TEST_EXECUTION_REQUEST,
    baseEnv: {},
    platform: 'linux',
    storage: { existsSync: () => false },
  }),
  session: TEST_CODEX_PREPARED.session,
  turn: TEST_CODEX_PREPARED.turn,
});

const TEST_CLAUDE_PREPARED = buildClaudeExecutionPlan({
  access: TEST_CLAUDE_ACCESS,
  hostPlan: Object.freeze({
    platform: 'linux',
    broker: Object.freeze({
      command: process.execPath,
      args: Object.freeze(['/test/coral-claude-appserver.cjs']),
      cwd: TEST_EXECUTION_REQUEST.cwd,
      transportMode: 'print',
      environment: Object.freeze([claudeBaseLayer({}, 'linux'), claudeBrokerSettingsLayer('print', 'linux')]),
    }),
    controller: Object.freeze({
      access: TEST_CLAUDE_ACCESS,
      environment: Object.freeze([claudeBaseLayer({}, 'linux'), claudeRoutingLayer(TEST_CLAUDE_ACCESS, 'linux')]),
    }),
  }) satisfies ClaudeExecutionPlan['host'],
  request: TEST_EXECUTION_REQUEST,
  baseEnv: {},
  storage: { existsSync: () => false },
  platform: 'linux',
});
export const TEST_CLAUDE_PLAN = Object.freeze({
  host: Object.freeze({
    platform: 'linux',
    broker: Object.freeze({
      command: process.execPath,
      args: Object.freeze(['/test/coral-claude-appserver.cjs']),
      cwd: TEST_EXECUTION_REQUEST.cwd,
      transportMode: 'print' as const,
      environment: Object.freeze([claudeBaseLayer({}, 'linux'), claudeBrokerSettingsLayer('print', 'linux')]),
    }),
    controller: Object.freeze({
      access: TEST_CLAUDE_ACCESS,
      environment: Object.freeze([claudeBaseLayer({}, 'linux'), claudeRoutingLayer(TEST_CLAUDE_ACCESS, 'linux')]),
    }),
  }),
  session: TEST_CLAUDE_PREPARED.session,
  turn: TEST_CLAUDE_PREPARED.turn,
}) satisfies ClaudeExecutionPlan;

export function prepareTestCodexAppServer(
  request: { readonly cwd: string; readonly coralEnv?: Record<string, string> },
  persistedContinuity?: Record<string, unknown>,
) {
  const hostPlan = codexAppServerLifecycle.planHost({
    purpose: 'execution',
    access: TEST_CODEX_ACCESS,
    request: {
      ...TEST_EXECUTION_REQUEST,
      cwd: fixtureCanonicalWorkDir(request.cwd),
      coralEnv: request.coralEnv ?? {},
    },
    persistedContinuity,
    baseEnv: {},
    platform: 'linux',
    storage: { existsSync: () => false },
  });
  buildCodexExecutionPlan({
    access: TEST_CODEX_ACCESS,
    hostPlan,
    request: {
      ...TEST_EXECUTION_REQUEST,
      cwd: fixtureCanonicalWorkDir(request.cwd),
      coralEnv: request.coralEnv ?? {},
    },
    persistedContinuity,
    baseEnv: {},
    platform: 'linux',
  });
  return codexAppServerLifecycle.compileStableHost(hostPlan);
}
