import { describe, expect, it, vi } from 'vitest';

import {
  allExecutionLifetimes,
  compileEnvironmentLayers,
  CORAL_PROCESS_ENV_KEYS,
  CORAL_TURN_ENV_KEYS,
  environmentLayer,
  EXECUTION_ENV_ALLOWLIST,
  filterEnvironmentValues,
  type EnvironmentLayer,
  type ExecutionLifetime,
} from '#src/providers/execution-plan.js';
import {
  buildClaudeExecutionPlan,
  buildClaudePreflightRuntime,
  compileClaudeBrokerEnvironment,
  compileClaudeControllerEnvironment,
  claudeRoutingEnv,
} from '#src/providers/claude/execution-plan.js';
import {
  buildCodexExecutionPlan,
  buildCodexPreflightRuntime,
  codexRoutingEnv,
} from '#src/providers/codex/execution-plan.js';
import {
  CLAUDE_ALLOWED_REQUEST_ENV_KEYS,
  CLAUDE_CREDENTIAL_ENV_KEYS,
  CLAUDE_PROTECTED_REQUEST_ENV_KEYS,
} from '#src/providers/claude/credential-policy.js';
import {
  CODEX_ALLOWED_REQUEST_ENV_KEYS,
  CODEX_CREDENTIAL_ENV_KEYS,
  CODEX_PROTECTED_REQUEST_ENV_KEYS,
} from '#src/providers/codex/credential-policy.js';
import { TEST_CLAUDE_SOURCE, TEST_CODEX_SOURCE } from '#tests/helpers/provider-credentials.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { hostKeyFromSpec } from '#src/coordinator/live/provider-hosts/index.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';
import { codexAppServerLifecycle } from '#src/providers/codex/provider-facets.js';

function layer(
  name: string,
  lifetime: ExecutionLifetime,
  values: Readonly<Record<string, string>>,
  writes: Iterable<string>,
  protects: Iterable<string> = [],
  platform = 'linux',
): EnvironmentLayer {
  return environmentLayer(
    {
      name,
      lifetime,
      provenance: `test:${name}`,
      values: filterEnvironmentValues(values, writes, platform),
      writes,
      protects,
    },
    platform,
  );
}

function compile(layers: readonly EnvironmentLayer[], platform = 'linux') {
  return compileEnvironmentLayers(layers, { platform, lifetimes: allExecutionLifetimes() });
}

function claudeLaunch(prepared: ReturnType<typeof buildClaudeExecutionPlan>) {
  return {
    host: claudeAppServerLifecycle.compileStableHost(prepared.plan.host),
    turnEnv: prepared.appServerTurnEnv,
  };
}

function codexLaunch(prepared: ReturnType<typeof buildCodexExecutionPlan>) {
  return {
    host: codexAppServerLifecycle.compileStableHost(prepared.plan.host),
    turnEnv: prepared.appServerTurnEnv,
  };
}

describe('provider execution plan', () => {
  it('exports runtime-immutable allowlist tuples rather than mutable Set facades', () => {
    const allowlists = [
      EXECUTION_ENV_ALLOWLIST,
      CORAL_PROCESS_ENV_KEYS,
      CORAL_TURN_ENV_KEYS,
      CLAUDE_CREDENTIAL_ENV_KEYS,
      CLAUDE_PROTECTED_REQUEST_ENV_KEYS,
      CLAUDE_ALLOWED_REQUEST_ENV_KEYS,
      CODEX_CREDENTIAL_ENV_KEYS,
      CODEX_PROTECTED_REQUEST_ENV_KEYS,
      CODEX_ALLOWED_REQUEST_ENV_KEYS,
    ];

    for (const allowlist of allowlists) {
      expect(Array.isArray(allowlist)).toBe(true);
      expect(Object.isFrozen(allowlist)).toBe(true);
      expect(allowlist).not.toHaveProperty('add');
      expect(() => (allowlist as unknown as string[]).push('MUTATION')).toThrow();
    }
  });

  it('rejects layer values that were not declared by writes before the plan can retain them', () => {
    expect(() =>
      environmentLayer(
        {
          name: 'request',
          lifetime: 'turn',
          provenance: 'test:request',
          values: { ALLOWED: 'yes', LATENT_SECRET: 'must-not-remain' },
          writes: ['ALLOWED'],
          protects: [],
        },
        'linux',
      ),
    ).toThrow(
      "provider_execution_environment_invalid: 'request' (test:request) contains values outside writes: LATENT_SECRET",
    );
  });

  it('constructs a closed environment and injects only the selected account routing', () => {
    const env = compile([
      layer(
        'base',
        'host',
        {
          PATH: '/bin',
          HOME: '/home/operator',
          OPENAI_API_KEY: 'must-not-leak',
          ANTHROPIC_API_KEY: 'must-not-leak',
          UNRELATED: 'must-not-leak',
        },
        EXECUTION_ENV_ALLOWLIST,
      ),
      layer('routing', 'host', codexRoutingEnv(TEST_CODEX_SOURCE), new Set(['CODEX_HOME']), new Set(['CODEX_HOME'])),
      layer('authority', 'turn', { CORAL_JOB_ID: 'job-1' }, new Set(['CORAL_JOB_ID']), new Set(['CORAL_JOB_ID'])),
      layer(
        'request',
        'turn',
        { CORAL_OWNER: 'reviewer', UNRELATED_REQUEST: 'must-not-leak' },
        new Set(['CORAL_OWNER']),
      ),
    ]);

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/operator',
      CORAL_OWNER: 'reviewer',
      CODEX_HOME: TEST_CODEX_SOURCE.home,
      CORAL_JOB_ID: 'job-1',
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it.each(['CODEX_HOME', ...CODEX_CREDENTIAL_ENV_KEYS])('rejects request override %s', (key) => {
    expect(() =>
      compile([
        layer(
          'routing',
          'host',
          codexRoutingEnv(TEST_CODEX_SOURCE),
          new Set(['CODEX_HOME']),
          new Set(['CODEX_HOME', ...CODEX_CREDENTIAL_ENV_KEYS]),
        ),
        layer('request', 'turn', { [key]: 'attacker-controlled' }, new Set([key])),
      ]),
    ).toThrow('protected environment collision');
  });

  it.each([...CLAUDE_CREDENTIAL_ENV_KEYS])(
    'does not let daemon-inherited Claude selector %s affect a bound execution',
    (key) => {
      expect(
        compile([
          layer('base', 'host', { PATH: '/bin', [key]: '1' }, EXECUTION_ENV_ALLOWLIST),
          layer('routing', 'host', claudeRoutingEnv(TEST_CLAUDE_SOURCE), new Set(['CLAUDE_CONFIG_DIR'])),
        ]),
      ).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: TEST_CLAUDE_SOURCE.configDir });
    },
  );

  it('does not emit CLAUDE_CONFIG_DIR for a caller-default Claude profile', () => {
    expect(
      compile([
        layer('base', 'host', { PATH: '/bin', CLAUDE_CONFIG_DIR: '/daemon/profile' }, EXECUTION_ENV_ALLOWLIST),
        layer(
          'routing',
          'host',
          claudeRoutingEnv({
            configDir: TEST_CLAUDE_SOURCE.configDir,
            projectsRoot: TEST_CLAUDE_SOURCE.projectsRoot,
            routing: { kind: 'default-home', homeDir: '/caller' },
          }),
          new Set(['HOME']),
        ),
      ]),
    ).toEqual({ PATH: '/bin', HOME: '/caller' });
  });

  it('rejects case-insensitive Windows collisions across environment layers', () => {
    expect(() =>
      compile(
        [
          layer('base', 'host', { Path: 'C:\\Windows' }, new Set(['PATH']), [], 'win32'),
          layer('request', 'turn', { PATH: 'C:\\Tools' }, new Set(['PATH']), [], 'win32'),
        ],
        'win32',
      ),
    ).toThrow("environment key collision 'Path' from 'base' (test:base) with 'PATH' from 'request' (test:request)");
    expect(() =>
      compile(
        [
          layer(
            'routing',
            'host',
            codexRoutingEnv(TEST_CODEX_SOURCE),
            new Set(['CODEX_HOME']),
            new Set(['CODEX_HOME']),
            'win32',
          ),
          layer('request', 'turn', { codex_home: 'C:\\attacker' }, new Set(['codex_home']), [], 'win32'),
        ],
        'win32',
      ),
    ).toThrow('environment key collision');
  });

  it.each(['linux', 'win32'])('rejects protected collisions deterministically on %s', (platform) => {
    expect(() =>
      compileEnvironmentLayers(
        [
          layer('account-routing', 'host', { CODEX_HOME: '/accounts/a' }, ['CODEX_HOME'], ['CODEX_HOME']),
          layer('turn-request', 'turn', { CODEX_HOME: '/accounts/b' }, ['CODEX_HOME']),
        ],
        { platform, lifetimes: allExecutionLifetimes() },
      ),
    ).toThrowError(
      "provider_execution_environment_invalid: protected environment collision 'CODEX_HOME' from 'turn-request' (test:turn-request) against 'account-routing' (test:account-routing)",
    );
  });

  it('keeps Claude broker account-neutral and binds only its controller', () => {
    const prepared = buildClaudeExecutionPlan({
      source: TEST_CLAUDE_SOURCE,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        name: 'claude',
        prompt: 'hello',
        cwd: '/workspace',
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
      CLAUDE_CONFIG_DIR: TEST_CLAUDE_SOURCE.configDir,
      CORAL_CHILD: '1',
      CORAL_SESSION_ID: 'session-1',
      CORAL_JOB_ID: 'job-1',
      CORAL_CLAUDE_MODEL_CAP: 'sonnet',
    });
    expect(controllerEnv).not.toHaveProperty('CORAL_CODEX_EFFORT');
    expect(plan.session.projectsRoot).toBe(TEST_CLAUDE_SOURCE.projectsRoot);
    expect(plan.host.broker.environment.every((entry) => entry.lifetime === 'host')).toBe(true);
    expect(plan.host.broker.environment.flatMap((entry) => Object.keys(entry.values))).not.toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(plan.host.controller.environment.flatMap((entry) => Object.keys(entry.values))).not.toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(brokerEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(prepared.prepareCliRequest({ command: 'claude', args: [] }).exactEnv).toEqual(controllerEnv);
  });

  it('keeps Claude broker identity invariant across owner, model, effort, and KB turn settings', () => {
    const prepare = (suffix: string) =>
      buildClaudeExecutionPlan({
        source: TEST_CLAUDE_SOURCE,
        request: {
          action: 'exec',
          sessionId: `session-${suffix}`,
          name: 'claude',
          prompt: 'hello',
          cwd: '/workspace',
          model: `model-${suffix}`,
          effort: suffix === 'a' ? 'low' : 'high',
          bypassPermissions: false,
          coralEnv: {
            CORAL_OWNER: `owner-${suffix}`,
            CORAL_EFFORT: suffix === 'a' ? 'low' : 'high',
            CORAL_KB_PATH: `/kb/${suffix}`,
            CORAL_CLAUDE_MODEL_CAP: suffix === 'a' ? 'sonnet' : 'opus',
            CORAL_CLAUDE_TRANSPORT: 'tui',
          },
        },
        baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: `secret-${suffix}` },
        protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: `handle-${suffix}` },
        storage: { existsSync: () => false },
        platform: 'linux',
      });
    const first = prepare('a');
    const second = prepare('b');

    expect(claudeLaunch(first).host).toEqual(claudeLaunch(second).host);
    expect(hostKeyFromSpec(claudeLaunch(first).host)).toBe(hostKeyFromSpec(claudeLaunch(second).host));
    expect(claudeLaunch(first).turnEnv).toEqual(claudeLaunch(second).turnEnv);
    expect(compileClaudeControllerEnvironment(first.plan)).not.toEqual(compileClaudeControllerEnvironment(second.plan));
  });

  it('keeps daemon HOME in one shared Claude broker while default-home bindings route only controllers', () => {
    const prepare = (homeDir: string, suffix: string) =>
      buildClaudeExecutionPlan({
        source: {
          configDir: `${homeDir}/.claude`,
          projectsRoot: `${homeDir}/.claude/projects`,
          routing: { kind: 'default-home', homeDir },
        },
        request: {
          action: 'exec',
          sessionId: `session-${suffix}`,
          prompt: 'hello',
          cwd: '/workspace',
          bypassPermissions: false,
          coralEnv: {},
        },
        baseEnv: { PATH: '/bin', HOME: '/daemon/infrastructure-home' },
        storage: { existsSync: () => false },
        platform: 'linux',
      });
    const first = prepare('/accounts/claude-a', 'a');
    const second = prepare('/accounts/claude-b', 'b');

    expect(compileClaudeBrokerEnvironment(first.plan)).toMatchObject({
      HOME: '/daemon/infrastructure-home',
    });
    expect(compileClaudeBrokerEnvironment(second.plan)).toMatchObject({
      HOME: '/daemon/infrastructure-home',
    });
    expect(compileClaudeBrokerEnvironment(first.plan)).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(compileClaudeBrokerEnvironment(second.plan)).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(compileClaudeControllerEnvironment(first.plan)).toMatchObject({ HOME: '/accounts/claude-a' });
    expect(compileClaudeControllerEnvironment(second.plan)).toMatchObject({ HOME: '/accounts/claude-b' });
    expect(claudeLaunch(first).host).toEqual(claudeLaunch(second).host);
    expect(hostKeyFromSpec(claudeLaunch(first).host)).toBe(hostKeyFromSpec(claudeLaunch(second).host));
  });

  it('prepares attachment host identity without constructing or admitting replacement turn authority', () => {
    const request = {
      action: 'exec' as const,
      sessionId: 'session-attachment',
      prompt: 'recover',
      cwd: '/workspace',
      bypassPermissions: false,
      coralEnv: { CORAL_KB_PATH: '/kb', CORAL_OWNER: 'reviewer' },
    };
    const codexExecution = buildCodexExecutionPlan({
      source: TEST_CODEX_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'replacement-only' },
      platform: 'linux',
    });
    const codexAttachmentPlan = buildCodexExecutionPlan({
      source: TEST_CODEX_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      platform: 'linux',
    });
    const claudeExecution = buildClaudeExecutionPlan({
      source: TEST_CLAUDE_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'replacement-only' },
      storage: { existsSync: () => false },
      platform: 'linux',
    });
    const claudeAttachmentPlan = buildClaudeExecutionPlan({
      source: TEST_CLAUDE_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      storage: { existsSync: () => false },
      platform: 'linux',
    });
    const codexAttachment = codexAppServerLifecycle.compileStableHost(codexAttachmentPlan.plan.host);
    const claudeAttachment = claudeAppServerLifecycle.compileStableHost(claudeAttachmentPlan.plan.host);

    expect(codexAttachment).toEqual(codexLaunch(codexExecution).host);
    expect(claudeAttachment).toEqual(claudeLaunch(claudeExecution).host);
    expect(JSON.stringify(codexAttachment)).not.toContain('replacement-only');
    expect(JSON.stringify(claudeAttachment)).not.toContain('replacement-only');
  });

  it.each([
    ['HTTPS_PROXY', 'http://proxy-a.example', 'http://proxy-b.example'],
    ['NODE_EXTRA_CA_CERTS', '/certs/a.pem', '/certs/b.pem'],
  ])('treats Codex process setting %s as stable host identity, never turn state', (key, firstValue, secondValue) => {
    const prepare = (value: string) =>
      buildCodexExecutionPlan({
        source: TEST_CODEX_SOURCE,
        request: {
          action: 'exec',
          sessionId: 'session-1',
          prompt: 'hello',
          cwd: '/workspace',
          bypassPermissions: false,
          coralEnv: { [key]: value },
        },
        baseEnv: { PATH: '/bin' },
        protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'turn-handle' },
        platform: 'linux',
      });
    const first = prepare(firstValue);
    const second = prepare(secondValue);

    expect(codexLaunch(first).host.env).toMatchObject({ [key]: firstValue });
    expect(codexLaunch(second).host.env).toMatchObject({ [key]: secondValue });
    expect(hostKeyFromSpec(codexLaunch(first).host)).not.toBe(hostKeyFromSpec(codexLaunch(second).host));
    expect(codexLaunch(first).turnEnv).not.toHaveProperty(key);
    expect(codexLaunch(second).turnEnv).not.toHaveProperty(key);
  });

  it.each([
    ['CORAL_KB_PATH', '/kb/a', '/kb/b'],
    ['CORAL_KB_ENABLE', '0', '1'],
  ])(
    'treats daemon-fixed Codex setting %s as stable host identity, never turn state',
    (key, firstValue, secondValue) => {
      const prepare = (value: string) =>
        buildCodexExecutionPlan({
          source: TEST_CODEX_SOURCE,
          request: {
            action: 'exec',
            sessionId: 'session-1',
            prompt: 'hello',
            cwd: '/workspace',
            bypassPermissions: false,
            coralEnv: { [key]: value },
          },
          baseEnv: { PATH: '/bin' },
          protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'turn-handle' },
          platform: 'linux',
        });
      const first = prepare(firstValue);
      const second = prepare(secondValue);

      expect(codexLaunch(first).host.env).toMatchObject({ [key]: firstValue });
      expect(codexLaunch(second).host.env).toMatchObject({ [key]: secondValue });
      expect(hostKeyFromSpec(codexLaunch(first).host)).not.toBe(hostKeyFromSpec(codexLaunch(second).host));
      expect(codexLaunch(first).turnEnv).not.toHaveProperty(key);
      expect(codexLaunch(second).turnEnv).not.toHaveProperty(key);
    },
  );

  it.each([
    ['HTTPS_PROXY', 'http://proxy-a.example', 'http://proxy-b.example'],
    ['NODE_EXTRA_CA_CERTS', '/certs/a.pem', '/certs/b.pem'],
  ])('keeps Claude controller process setting %s out of shared broker identity', (key, firstValue, secondValue) => {
    const prepare = (value: string) =>
      buildClaudeExecutionPlan({
        source: TEST_CLAUDE_SOURCE,
        request: {
          action: 'exec',
          sessionId: 'session-1',
          name: 'claude',
          prompt: 'hello',
          cwd: '/workspace',
          bypassPermissions: false,
          coralEnv: { [key]: value },
        },
        baseEnv: { PATH: '/bin' },
        protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'turn-handle' },
        storage: { existsSync: () => false },
        platform: 'linux',
      });
    const first = prepare(firstValue);
    const second = prepare(secondValue);

    expect(claudeLaunch(first).host).toEqual(claudeLaunch(second).host);
    expect(hostKeyFromSpec(claudeLaunch(first).host)).toBe(hostKeyFromSpec(claudeLaunch(second).host));
    expect(compileClaudeControllerEnvironment(first.plan)).toMatchObject({ [key]: firstValue });
    expect(compileClaudeControllerEnvironment(second.plan)).toMatchObject({ [key]: secondValue });
    expect(compileClaudeBrokerEnvironment(first.plan)).not.toHaveProperty(key);
    expect(compileClaudeBrokerEnvironment(second.plan)).not.toHaveProperty(key);
  });

  it.each([
    ['CORAL_KB_PATH', '/kb/a', '/kb/b'],
    ['CORAL_KB_ENABLE', '0', '1'],
  ])(
    'keeps daemon-fixed Claude setting %s on the controller and out of broker identity',
    (key, firstValue, secondValue) => {
      const prepare = (value: string) =>
        buildClaudeExecutionPlan({
          source: TEST_CLAUDE_SOURCE,
          request: {
            action: 'exec',
            sessionId: 'session-1',
            name: 'claude',
            prompt: 'hello',
            cwd: '/workspace',
            bypassPermissions: false,
            coralEnv: { [key]: value },
          },
          baseEnv: { PATH: '/bin' },
          storage: { existsSync: () => false },
          platform: 'linux',
        });
      const first = prepare(firstValue);
      const second = prepare(secondValue);

      expect(claudeLaunch(first).host).toEqual(claudeLaunch(second).host);
      expect(hostKeyFromSpec(claudeLaunch(first).host)).toBe(hostKeyFromSpec(claudeLaunch(second).host));
      expect(compileClaudeControllerEnvironment(first.plan)).toMatchObject({ [key]: firstValue });
      expect(compileClaudeControllerEnvironment(second.plan)).toMatchObject({ [key]: secondValue });
      expect(compileClaudeBrokerEnvironment(first.plan)).not.toHaveProperty(key);
      expect(compileClaudeBrokerEnvironment(second.plan)).not.toHaveProperty(key);
    },
  );

  it('keeps owner and effort turn-scoped for both providers', () => {
    const request = {
      action: 'exec' as const,
      sessionId: 'session-1',
      prompt: 'hello',
      cwd: '/workspace',
      bypassPermissions: false,
      coralEnv: { CORAL_OWNER: 'reviewer', CORAL_EFFORT: 'high' },
    };
    const codex = buildCodexExecutionPlan({
      source: TEST_CODEX_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      platform: 'linux',
    });
    const claude = buildClaudeExecutionPlan({
      source: TEST_CLAUDE_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      storage: { existsSync: () => false },
      platform: 'linux',
    });

    expect(codexLaunch(codex).host.env).not.toHaveProperty('CORAL_OWNER');
    expect(codexLaunch(codex).host.env).not.toHaveProperty('CORAL_EFFORT');
    expect(codexLaunch(codex).turnEnv).toMatchObject({ CORAL_OWNER: 'reviewer', CORAL_EFFORT: 'high' });
    expect(compileClaudeBrokerEnvironment(claude.plan)).not.toHaveProperty('CORAL_OWNER');
    expect(compileClaudeBrokerEnvironment(claude.plan)).not.toHaveProperty('CORAL_EFFORT');
    expect(compileClaudeControllerEnvironment(claude.plan)).toMatchObject({
      CORAL_OWNER: 'reviewer',
      CORAL_EFFORT: 'high',
    });
  });

  it('removes inherited secrets, request credentials, and cross-provider settings before storing any plan layer', () => {
    const claude = buildClaudeExecutionPlan({
      source: TEST_CLAUDE_SOURCE,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        name: 'claude',
        prompt: 'hello',
        cwd: '/workspace',
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
      source: TEST_CODEX_SOURCE,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        name: 'codex',
        prompt: 'hello',
        cwd: '/workspace',
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
      ...codex.plan.turn.processEnvironment,
    ];
    const storedKeys = storedLayers.flatMap((entry) => Object.keys(entry.values));

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

  it('keeps Codex job-exclusive while callback authority remains process-environment scoped', () => {
    const prepared = buildCodexExecutionPlan({
      source: TEST_CODEX_SOURCE,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        prompt: 'hello',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      },
      baseEnv: { PATH: '/bin' },
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'turn-handle' },
      platform: 'linux',
    });
    expect(prepared.plan.host.leaseMode).toBe('job-exclusive');
    expect(prepared.plan.host.environment.every((entry) => entry.lifetime === 'host')).toBe(true);
    expect(prepared.plan.turn.processEnvironment).toEqual(
      expect.arrayContaining([expect.objectContaining({ lifetime: 'turn', provenance: 'coral-child-principal' })]),
    );
  });

  it('derives identical stable routing for normal and recovery preparation', () => {
    const request = {
      action: 'resume' as const,
      sessionId: 'session-1',
      name: 'provider-session',
      prompt: 'continue',
      cwd: '/workspace',
      bypassPermissions: false,
      conversationRef: 'conversation-1',
      coralEnv: {},
    };
    const normalClaude = buildClaudeExecutionPlan({
      source: TEST_CLAUDE_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      storage: { existsSync: () => false },
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'normal-handle' },
      platform: 'linux',
    });
    const recoveryClaude = buildClaudeExecutionPlan({
      source: TEST_CLAUDE_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      storage: { existsSync: () => false },
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'recovery-handle' },
      platform: 'linux',
    });
    const normalCodex = buildCodexExecutionPlan({
      source: TEST_CODEX_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'normal-handle' },
      platform: 'linux',
    });
    const recoveryCodex = buildCodexExecutionPlan({
      source: TEST_CODEX_SOURCE,
      request,
      baseEnv: { PATH: '/bin' },
      protectedEnv: { CORAL_CHILD_PRINCIPAL_HANDLE: 'recovery-handle' },
      platform: 'linux',
    });

    expect(normalClaude.plan.host).toEqual(recoveryClaude.plan.host);
    expect(claudeLaunch(normalClaude).host).toEqual(claudeLaunch(recoveryClaude).host);
    expect(compileClaudeBrokerEnvironment(normalClaude.plan)).toEqual(
      compileClaudeBrokerEnvironment(recoveryClaude.plan),
    );
    expect(normalCodex.plan.host).toEqual(recoveryCodex.plan.host);
    expect(codexLaunch(normalCodex).host).toEqual(codexLaunch(recoveryCodex).host);
    expect(normalClaude.plan.turn.controllerEnvironment).not.toEqual(recoveryClaude.plan.turn.controllerEnvironment);
    expect(normalCodex.plan.turn.processEnvironment).not.toEqual(recoveryCodex.plan.turn.processEnvironment);
    expect(codexLaunch(normalCodex).turnEnv).not.toEqual(codexLaunch(recoveryCodex).turnEnv);
  });

  it('constructs Codex preflight execution inside the provider vertical', async () => {
    const runtime = new SimulationRuntime({
      env: { PATH: '/bin', OPENAI_API_KEY: 'must-not-leak', CODEX_HOME: '/daemon/codex' },
    });
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: '', status: 0 });
    const preflight = buildCodexPreflightRuntime({
      process: runtime.process,
      storage: runtime.storage,
      env: runtime.env,
      time: runtime.time,
      credentialSource: { ...TEST_CODEX_SOURCE, home: '/accounts/codex-a' },
      cwd: '/workspace/project',
      baseEnv: runtime.env.fullSnapshot(),
      requestEnv: { CORAL_CODEX_EFFORT: 'high', CORAL_CLAUDE_MODEL_CAP: 'must-not-leak' },
      platform: runtime.env.platform(),
    });

    await preflight.runExact('codex', ['app-server', '--help'], { timeout: 10_000 });

    expect(exec).toHaveBeenCalledWith('codex', ['app-server', '--help'], {
      timeout: 10_000,
      cwd: '/workspace/project',
      env: {
        PATH: '/bin',
        HOME: expect.any(String),
        CODEX_HOME: '/accounts/codex-a',
        CORAL_CODEX_EFFORT: 'high',
      },
    });
  });

  it('compiles Claude preflight through the Windows command shell with its bound credential environment', async () => {
    const runtime = new SimulationRuntime();
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: '', status: 0 });
    const preflight = buildClaudePreflightRuntime({
      process: runtime.process,
      storage: runtime.storage,
      env: runtime.env,
      time: runtime.time,
      credentialSource: {
        configDir: 'C:\\Users\\operator\\.claude-work',
        projectsRoot: 'C:\\Users\\operator\\.claude-work\\projects',
        routing: { kind: 'config-dir' },
      },
      cwd: 'C:\\workspace',
      baseEnv: { PATH: 'C:\\Windows\\System32' },
      requestEnv: {},
      platform: 'win32',
    });

    await preflight.runExact('claude', ['--version'], { timeout: 10_000, encoding: 'utf-8' });

    expect(exec).toHaveBeenCalledWith('claude.cmd', ['--version'], {
      timeout: 10_000,
      encoding: 'utf-8',
      cwd: 'C:\\workspace',
      env: {
        PATH: 'C:\\Windows\\System32',
        CLAUDE_CONFIG_DIR: 'C:\\Users\\operator\\.claude-work',
      },
      shell: true,
    });
  });

  it('compiles Codex preflight through the Windows command shell with its bound credential environment', async () => {
    const runtime = new SimulationRuntime();
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue({ stdout: '', stderr: '', status: 0 });
    const preflight = buildCodexPreflightRuntime({
      process: runtime.process,
      storage: runtime.storage,
      env: runtime.env,
      time: runtime.time,
      credentialSource: { home: 'C:\\Users\\operator\\.codex-work' },
      cwd: 'C:\\workspace',
      baseEnv: { PATH: 'C:\\Windows\\System32' },
      requestEnv: {},
      platform: 'win32',
    });

    await preflight.runExact('codex', ['app-server', '--help'], { timeout: 10_000, encoding: 'utf-8' });

    expect(exec).toHaveBeenCalledWith('codex.cmd', ['app-server', '--help'], {
      timeout: 10_000,
      encoding: 'utf-8',
      cwd: 'C:\\workspace',
      env: {
        PATH: 'C:\\Windows\\System32',
        CODEX_HOME: 'C:\\Users\\operator\\.codex-work',
      },
      shell: true,
    });
  });
});
