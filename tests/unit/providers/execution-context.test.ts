import { describe, expect, it, vi } from 'vitest';

import { buildExactProviderEnv } from '#src/providers/execution-context.js';
import {
  buildClaudeExecutionContext,
  buildClaudePreflightRuntime,
  claudeRoutingEnv,
} from '#src/providers/claude/execution-context.js';
import { buildCodexPreflightRuntime, codexRoutingEnv } from '#src/providers/codex/execution-context.js';
import { CLAUDE_CREDENTIAL_ENV_KEYS } from '#src/providers/claude/credential-policy.js';
import { CODEX_CREDENTIAL_ENV_KEYS } from '#src/providers/codex/credential-policy.js';
import { TEST_CLAUDE_SOURCE, TEST_CODEX_SOURCE } from '#tests/helpers/provider-credentials.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('provider execution context', () => {
  it('constructs a closed environment and injects only the selected account routing', () => {
    const env = buildExactProviderEnv({
      baseEnv: {
        PATH: '/bin',
        HOME: '/home/operator',
        OPENAI_API_KEY: 'must-not-leak',
        ANTHROPIC_API_KEY: 'must-not-leak',
        UNRELATED: 'must-not-leak',
      },
      requestEnv: { CORAL_OWNER: 'reviewer', UNRELATED_REQUEST: 'must-not-leak' },
      protectedEnv: { CORAL_JOB_ID: 'job-1' },
      routingEnv: codexRoutingEnv(TEST_CODEX_SOURCE),
      platform: 'linux',
    });

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
      buildExactProviderEnv({
        baseEnv: { PATH: '/bin' },
        requestEnv: { [key]: 'attacker-controlled' },
        routingEnv: codexRoutingEnv(TEST_CODEX_SOURCE),
        protectedRequestKeys: new Set(['CODEX_HOME', ...CODEX_CREDENTIAL_ENV_KEYS]),
        platform: 'linux',
      }),
    ).toThrow('protected environment override');
  });

  it.each([...CLAUDE_CREDENTIAL_ENV_KEYS])(
    'does not let daemon-inherited Claude selector %s affect a bound execution',
    (key) => {
      expect(
        buildExactProviderEnv({
          baseEnv: { PATH: '/bin', [key]: '1' },
          routingEnv: claudeRoutingEnv(TEST_CLAUDE_SOURCE),
          platform: 'linux',
        }),
      ).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: TEST_CLAUDE_SOURCE.configDir });
    },
  );

  it('does not emit CLAUDE_CONFIG_DIR for a caller-default Claude profile', () => {
    expect(
      buildExactProviderEnv({
        baseEnv: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/daemon/profile' },
        routingEnv: claudeRoutingEnv({
          configDir: TEST_CLAUDE_SOURCE.configDir,
          projectsRoot: TEST_CLAUDE_SOURCE.projectsRoot,
          routing: { kind: 'default-home', homeDir: '/caller' },
        }),
        platform: 'linux',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/caller' });
  });

  it('rejects case-insensitive Windows collisions across environment layers', () => {
    expect(() =>
      buildExactProviderEnv({
        baseEnv: { Path: 'C:\\Windows' },
        requestEnv: { PATH: 'C:\\Tools' },
        routingEnv: codexRoutingEnv(TEST_CODEX_SOURCE),
        platform: 'win32',
      }),
    ).toThrow("environment key collision 'Path'/'PATH'");
    expect(() =>
      buildExactProviderEnv({
        baseEnv: {},
        requestEnv: { codex_home: 'C:\\attacker' },
        routingEnv: codexRoutingEnv(TEST_CODEX_SOURCE),
        protectedRequestKeys: new Set(['CODEX_HOME']),
        platform: 'win32',
      }),
    ).toThrow('protected environment override');
  });

  it('keeps Claude broker account-neutral and binds only its controller', () => {
    const prepared = buildClaudeExecutionContext({
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
      protectedEnv: { CORAL_JOB_ID: 'job-1' },
      platform: 'linux',
    });

    const context = prepared.context;
    expect(context.brokerEnv).toEqual({
      PATH: '/bin',
      CORAL_CLAUDE_MODEL_CAP: 'sonnet',
      CORAL_CLAUDE_TRANSPORT: 'tui',
    });
    expect(context.controllerEnv).toMatchObject({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: TEST_CLAUDE_SOURCE.configDir,
      CORAL_CHILD: '1',
      CORAL_SESSION_ID: 'session-1',
      CORAL_JOB_ID: 'job-1',
      CORAL_CLAUDE_MODEL_CAP: 'sonnet',
      CORAL_CLAUDE_TRANSPORT: 'tui',
    });
    expect(context.controllerEnv).not.toHaveProperty('CORAL_CODEX_EFFORT');
    expect(context.projectsRoot).toBe(TEST_CLAUDE_SOURCE.projectsRoot);
    expect(prepared.prepareCliRequest({ command: 'claude', args: [] }).exactEnv).toEqual(context.controllerEnv);
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
