import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeContinuity,
  mapSessionEnsureParams,
  mapTurnStartParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
} from '#src/providers/claude/request-mapping.js';
import { buildClaudeExecutionPlan } from '#src/providers/claude/execution-plan.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';
import { TEST_CLAUDE_SOURCE } from '#tests/helpers/provider-credentials.js';
import type { ClaudeBootstrapSignature } from '#src/providers/claude/request-prep.js';
import { CORAL_CLAUDE_TRANSPORT_ENV } from '#src/providers/claude/transport-mode.js';

const BOOTSTRAP_SIGNATURE: ClaudeBootstrapSignature = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:test',

  bootstrapConfigHash: 'sha256:test-bootstrap',
  permissionMode: 'default',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function withBundleDir<T>(run: () => T): T {
  vi.stubGlobal('__BUNDLE_DIR__', '/plugin/build');
  return run();
}

function withPluginRoot<T>(run: () => T): T {
  vi.stubGlobal('__PLUGIN_ROOT__', '/plugin');
  return run();
}

function prepareBroker(options: {
  cwd?: string;
  coralEnv?: Record<string, string>;
  baseEnv?: Record<string, string>;
  existsSync?: (path: string) => boolean;
}) {
  const input = {
    source: TEST_CLAUDE_SOURCE,
    request: {
      action: 'exec',
      sessionId: 'session',
      prompt: 'test',
      cwd: options.cwd ?? '/workspace',
      bypassPermissions: false,
      coralEnv: options.coralEnv ?? {},
    },
    baseEnv: options.baseEnv ?? {},
    storage: { existsSync: options.existsSync ?? (() => true) },
    platform: 'linux',
  } as const;
  const hostPlan = claudeAppServerLifecycle.planHost({ purpose: 'execution', ...input });
  buildClaudeExecutionPlan({ ...input, hostPlan });
  return claudeAppServerLifecycle.compileStableHost(hostPlan);
}

describe('Claude continuity refs', () => {
  it('drops empty persisted refs at the provider boundary', () => {
    expect(
      readClaudePersistedContinuity({
        brokerSessionKey: '',
        envHash: '',
        conversationRef: '',
        brokerTurnId: '',
      }),
    ).toEqual({});
  });

  it('drops persisted bootstrap signatures with unknown permission modes', () => {
    expect(
      readClaudePersistedContinuity({
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:test',

          bootstrapConfigHash: 'sha256:test-bootstrap',
          permissionMode: 'unknown',
        },
      }),
    ).toEqual({});
  });

  it('preserves persisted bootstrap signatures with auto permission mode', () => {
    expect(
      readClaudePersistedContinuity({
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:test',

          bootstrapConfigHash: 'sha256:test-bootstrap',
          permissionMode: 'auto',
        },
      }).bootstrapSignature,
    ).toEqual({
      cwd: '/workspace',
      systemPromptHash: 'sha256:test',

      bootstrapConfigHash: 'sha256:test-bootstrap',
      permissionMode: 'auto',
    });
  });

  it('builds continuity from non-empty refs only', () => {
    expect(
      buildClaudeContinuity({
        bootstrapSignature: BOOTSTRAP_SIGNATURE,
      }),
    ).toEqual({
      bootstrapSignature: BOOTSTRAP_SIGNATURE,
    });
  });

  it('preserves canonical persisted refs when an update carries empty strings', () => {
    expect(
      withClaudeContinuity(
        {
          brokerSessionKey: 'broker-1',
          bootstrapSignature: BOOTSTRAP_SIGNATURE,
          envHash: 'env-1',
          conversationRef: 'conversation-1',
          brokerTurnId: 'turn-1',
        },
        {},
      ),
    ).toEqual({
      bootstrapSignature: BOOTSTRAP_SIGNATURE,
    });
  });
});

describe('Claude appserver request mapping', () => {
  it('prefers the active bundle appserver when running from build output', () => {
    const spec = withPluginRoot(() =>
      withBundleDir(() => prepareBroker({ existsSync: (path) => path === '/plugin/build/coral-claude-appserver.cjs' })),
    );

    expect(spec.args).toEqual(['/plugin/build/coral-claude-appserver.cjs']);
  });

  it('defaults the Claude broker transport to print mode in provider server identity', () => {
    const spec = withPluginRoot(() => prepareBroker({}));

    expect(spec.env).toEqual({ [CORAL_CLAUDE_TRANSPORT_ENV]: 'print' });
    expect(spec.env).toMatchObject({ CORAL_CLAUDE_TRANSPORT: 'print' });
  });

  it('carries explicit TUI transport into provider server identity', () => {
    const spec = withPluginRoot(() => prepareBroker({ coralEnv: { [CORAL_CLAUDE_TRANSPORT_ENV]: 'tui' } }));

    expect(spec.env).toEqual({ [CORAL_CLAUDE_TRANSPORT_ENV]: 'tui' });
    expect(spec.env).toMatchObject({ CORAL_CLAUDE_TRANSPORT: 'tui' });
  });

  it('carries model and effort in session bootstrap while turn/start only sends the prompt', () => {
    const ensure = mapSessionEnsureParams(
      {
        action: 'exec',
        sessionId: 'fresh-session',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
        model: 'claude-sonnet-4-6',
        effort: 'high',
      },
      { sha256: () => 'system-hash' },
      { derivedSystemPrompt: 'system prompt', controllerEnv: {}, projectsRoot: '/home/user/.claude/projects' },
    );

    expect(ensure).toMatchObject({
      cwd: '/workspace',
      systemPromptHash: 'sha256:system-hash',
      permissionMode: 'default',
      systemPrompt: 'system prompt',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      conversationRef: 'fresh-session',
      resumeExisting: false,
    });

    expect(mapTurnStartParams('hello', 'broker-1', { uuid: () => 'turn-1' })).toEqual({
      brokerSessionKey: 'broker-1',
      brokerTurnId: 'turn-1',
      prompt: 'hello',
    });
  });

  it('keeps one account-neutral broker while binding each controller to its Claude account', () => {
    const brokerA = withPluginRoot(() => prepareBroker({ baseEnv: { PATH: '/bin' } }));
    const brokerB = withPluginRoot(() => prepareBroker({ baseEnv: { PATH: '/bin' } }));
    const ensureA = mapSessionEnsureParams(
      { action: 'exec', sessionId: 'session-a', cwd: '/workspace', bypassPermissions: false, coralEnv: {} },
      { sha256: () => 'system-hash' },
      {
        controllerEnv: { CLAUDE_CONFIG_DIR: '/accounts/a' },
        projectsRoot: '/accounts/a/projects',
      },
    );
    const ensureB = mapSessionEnsureParams(
      { action: 'exec', sessionId: 'session-b', cwd: '/workspace', bypassPermissions: false, coralEnv: {} },
      { sha256: () => 'system-hash' },
      {
        controllerEnv: { CLAUDE_CONFIG_DIR: '/accounts/b' },
        projectsRoot: '/accounts/b/projects',
      },
    );

    expect(brokerA).toEqual(brokerB);
    expect(brokerA.leaseMode).toBe('shared');
    expect(brokerA.idlePolicy).toBe('host-stats');
    expect(brokerA.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(brokerA.env).not.toHaveProperty('CORAL_CHILD_PRINCIPAL_HANDLE');
    expect(brokerA.env).not.toHaveProperty('CORAL_JOB_ID');
    expect(brokerA.env).not.toHaveProperty('CORAL_SESSION_ID');
    expect(ensureA.controllerEnv).toMatchObject({ CLAUDE_CONFIG_DIR: '/accounts/a' });
    expect(ensureA.projectsRoot).toBe('/accounts/a/projects');
    expect(ensureB.controllerEnv).toMatchObject({ CLAUDE_CONFIG_DIR: '/accounts/b' });
    expect(ensureB.projectsRoot).toBe('/accounts/b/projects');
  });
});
