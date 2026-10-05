import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  buildClaudeExecutionPlan as buildClaudeExecutionPlanWithHost,
  buildClaudeHost,
  compileClaudeBrokerEnvironment,
  compileClaudeControllerEnvironment,
} from '#src/providers/claude/execution-plan.js';
import {
  buildCodexExecutionPlan as buildCodexExecutionPlanWithHost,
  buildCodexHost,
} from '#src/providers/codex/execution-plan.js';
import { TEST_CLAUDE_ACCESS, TEST_CODEX_ACCESS } from '#tests/helpers/provider-credentials.js';

import { hostKeyFromSpec } from '#src/providers/host-identity.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';
import { resolveClaudeTransportMode } from '#src/providers/claude/transport-mode.js';

beforeAll(() => vi.stubGlobal('__PLUGIN_ROOT__', '/test/plugin'));
afterAll(() => vi.unstubAllGlobals());

function buildClaudeExecutionPlan(options: Omit<Parameters<typeof buildClaudeExecutionPlanWithHost>[0], 'hostPlan'>) {
  const host = buildClaudeHost({
    access: options.access,
    request: options.request,
    baseEnv: options.baseEnv,
    platform: options.platform,
    hostRoot: '/test/plugin/bridge',
    transportMode: resolveClaudeTransportMode(options.request.coralEnv),
  });
  const prepared = buildClaudeExecutionPlanWithHost({
    ...options,
    hostPlan: host,
  });
  return { ...prepared, plan: { host, session: prepared.session, turn: prepared.turn } };
}

function buildCodexExecutionPlan(options: Omit<Parameters<typeof buildCodexExecutionPlanWithHost>[0], 'hostPlan'>) {
  const host = buildCodexHost(options);
  const prepared = buildCodexExecutionPlanWithHost({ ...options, hostPlan: host });
  return { ...prepared, plan: { host, session: prepared.session, turn: prepared.turn } };
}

function codexLaunch(prepared: ReturnType<typeof buildCodexExecutionPlan>) {
  return codexAppServerLifecycle.compileStableHost(prepared.plan.host);
}

function codexThreadEnvironment(prepared: ReturnType<typeof buildCodexExecutionPlan>) {
  return (
    prepared.plan.turn.threadConfig.shell_environment_policy as {
      readonly set: Readonly<Record<string, string>>;
    }
  ).set;
}

describe('provider execution plan', () => {
  it('compiles a relative dist root with the source appserver entrypoint', () => {
    const host = buildClaudeHost({
      access: TEST_CLAUDE_ACCESS,
      request: { cwd: fixtureCanonicalWorkDir('/workspace'), coralEnv: {} },
      baseEnv: {},
      platform: process.platform,
      hostRoot: 'dist',
      transportMode: 'print',
    });
    expect(host.broker.args).toEqual([join('dist', 'providers', 'claude', 'appserver', 'server.js')]);
  });

  it('keeps Claude broker account-neutral and binds only its controller', () => {
    const prepared = buildClaudeExecutionPlan({
      access: TEST_CLAUDE_ACCESS,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        name: 'claude',
        prompt: 'hello',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {
          CORAL_CLAUDE_MODEL_CAP: 'sonnet',
          CORAL_CLAUDE_TRANSPORT: 'tui',
          CORAL_CODEX_EFFORT: 'must-not-leak',
        },
      },
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'must-not-leak' },
      storage: { existsSync: () => false },
      protectedEnv: { CORAL_JOB_ID: 'job-1' },
      platform: 'linux',
    });

    const plan = prepared.plan;
    const brokerEnv = compileClaudeBrokerEnvironment(plan);
    const controllerEnv = compileClaudeControllerEnvironment(plan);
    expect(brokerEnv).toEqual({
      PATH: '/bin',
      CORAL_CLAUDE_TRANSPORT: 'tui',
    });
    expect(controllerEnv).toMatchObject({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: TEST_CLAUDE_ACCESS.configDir,
      CORAL_CHILD: '1',
      CORAL_SESSION_ID: 'session-1',
      CORAL_JOB_ID: 'job-1',
      CORAL_CLAUDE_MODEL_CAP: 'sonnet',
    });
    expect(controllerEnv).not.toHaveProperty('CORAL_CODEX_EFFORT');
    expect(plan.session.projectsRoot).toBe(TEST_CLAUDE_ACCESS.projectsRoot);
    expect(plan.host.broker.environment.every((entry) => entry.lifetime === 'host')).toBe(true);
    expect(plan.host.broker.environment.flatMap((entry) => Object.keys(entry.values))).not.toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(plan.host.controller.environment.flatMap((entry) => Object.keys(entry.values))).not.toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(brokerEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(prepared).not.toHaveProperty('prepareCliRequest');
  });

  it('reuses a Codex host for one profile and splits hosts across profiles', () => {
    const prepare = (home: string, sessionId: string, handle: string) =>
      buildCodexExecutionPlan({
        access: { home },
        request: {
          action: 'exec',
          sessionId,
          prompt: 'hello',
          cwd: fixtureCanonicalWorkDir('/workspace'),
          bypassPermissions: false,
          coralEnv: {},
        },
        baseEnv: { PATH: '/bin' },
        protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: handle },
        platform: 'linux',
      });
    const first = prepare('/accounts/a', 'session-a', 'handle-a');
    const second = prepare('/accounts/a', 'session-b', 'handle-b');
    const otherProfile = prepare('/accounts/b', 'session-c', 'handle-c');

    expect(first.plan.host.leaseMode).toBe('shared');
    expect(codexLaunch(first).idleRetirement).toBe('unleased');
    expect(hostKeyFromSpec(codexLaunch(first))).toBe(hostKeyFromSpec(codexLaunch(second)));
    expect(hostKeyFromSpec(codexLaunch(first))).not.toBe(hostKeyFromSpec(codexLaunch(otherProfile)));
    expect(codexThreadEnvironment(first)).toMatchObject({
      CORAL_CHILD: '1',
      CORAL_SESSION_ID: 'session-a',
      CORAL_CHILD_PRINCIPAL_HANDLE: 'handle-a',
    });
    expect(codexThreadEnvironment(second)).toMatchObject({
      CORAL_CHILD: '1',
      CORAL_SESSION_ID: 'session-b',
      CORAL_CHILD_PRINCIPAL_HANDLE: 'handle-b',
    });
  });

  it('removes inherited secrets, request credentials, and cross-provider settings before storing any plan layer', () => {
    const claude = buildClaudeExecutionPlan({
      access: TEST_CLAUDE_ACCESS,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        name: 'claude',
        prompt: 'hello',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {
          ANTHROPIC_API_KEY: 'request-secret',
          OPENAI_API_KEY: 'cross-provider-secret',
          CORAL_CODEX_EFFORT: 'cross-provider-setting',
          UNRELATED_SECRET: 'unrelated',
        },
      },
      baseEnv: {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'inherited-secret',
        OPENAI_API_KEY: 'inherited-cross-provider-secret',
        UNRELATED_SECRET: 'inherited-unrelated',
      },
      storage: { existsSync: () => false },
      platform: 'linux',
    });
    const codex = buildCodexExecutionPlan({
      access: TEST_CODEX_ACCESS,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        name: 'codex',
        prompt: 'hello',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {
          OPENAI_API_KEY: 'request-secret',
          ANTHROPIC_API_KEY: 'cross-provider-secret',
          CORAL_CLAUDE_MODEL_CAP: 'cross-provider-setting',
          UNRELATED_SECRET: 'unrelated',
        },
      },
      baseEnv: {
        PATH: '/bin',
        OPENAI_API_KEY: 'inherited-secret',
        ANTHROPIC_API_KEY: 'inherited-cross-provider-secret',
        UNRELATED_SECRET: 'inherited-unrelated',
      },
      platform: 'linux',
    });
    const storedLayers = [
      ...claude.plan.host.broker.environment,
      ...claude.plan.host.controller.environment,
      ...claude.plan.turn.controllerEnvironment,
      ...codex.plan.host.environment,
    ];
    const storedKeys = [
      ...storedLayers.flatMap((entry) => Object.keys(entry.values)),
      ...Object.keys(codexThreadEnvironment(codex)),
    ];

    expect(storedKeys).not.toEqual(
      expect.arrayContaining([
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'CORAL_CODEX_EFFORT',
        'CORAL_CLAUDE_MODEL_CAP',
        'UNRELATED_SECRET',
      ]),
    );
  });
});
