import { describe, expect, it } from 'vitest';

import { buildExactProviderEnv, buildProviderExecutionContext } from '#src/providers/execution-context.js';
import {
  PROVIDER_CREDENTIAL_OVERRIDE_ENV_KEYS,
  PROVIDER_ROUTING_ENV_KEYS,
  UNSUPPORTED_CLAUDE_SELECTOR_ENV_KEYS,
} from '#src/runtime/provider-credentials.js';
import { TEST_CLAUDE_SOURCE, TEST_CODEX_SOURCE } from '#tests/helpers/provider-credentials.js';

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
      source: TEST_CODEX_SOURCE,
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

  it.each([...PROVIDER_ROUTING_ENV_KEYS, ...PROVIDER_CREDENTIAL_OVERRIDE_ENV_KEYS])(
    'rejects request override %s',
    (key) => {
      expect(() =>
        buildExactProviderEnv({
          baseEnv: { PATH: '/bin' },
          requestEnv: { [key]: 'attacker-controlled' },
          source: TEST_CODEX_SOURCE,
          platform: 'linux',
        }),
      ).toThrow('protected environment override');
    },
  );

  it.each([...UNSUPPORTED_CLAUDE_SELECTOR_ENV_KEYS])(
    'rejects inherited Claude selector %s only for Claude launches',
    (key) => {
      expect(() =>
        buildExactProviderEnv({
          baseEnv: { PATH: '/bin', [key]: '1' },
          source: TEST_CLAUDE_SOURCE,
          platform: 'linux',
        }),
      ).toThrow(`Unsupported Claude credential selector '${key}'`);
      expect(
        buildExactProviderEnv({
          baseEnv: { PATH: '/bin', [key]: '1' },
          source: TEST_CODEX_SOURCE,
          platform: 'linux',
        }),
      ).toEqual({ PATH: '/bin', CODEX_HOME: TEST_CODEX_SOURCE.home });
    },
  );

  it('rejects case-insensitive Windows collisions across environment layers', () => {
    expect(() =>
      buildExactProviderEnv({
        baseEnv: { Path: 'C:\\Windows' },
        requestEnv: { PATH: 'C:\\Tools' },
        source: TEST_CODEX_SOURCE,
        platform: 'win32',
      }),
    ).toThrow("environment key collision 'Path'/'PATH'");
    expect(() =>
      buildExactProviderEnv({
        baseEnv: {},
        requestEnv: { codex_home: 'C:\\attacker' },
        source: TEST_CODEX_SOURCE,
        platform: 'win32',
      }),
    ).toThrow('protected environment override');
  });

  it('keeps Claude broker account-neutral and binds only its controller', () => {
    const context = buildProviderExecutionContext({
      source: TEST_CLAUDE_SOURCE,
      request: {
        action: 'exec',
        sessionId: 'session-1',
        name: 'claude',
        prompt: 'hello',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      },
      baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'must-not-leak' },
      protectedEnv: { CORAL_JOB_ID: 'job-1' },
      platform: 'linux',
    });

    expect(context.provider).toBe('claude');
    if (context.provider !== 'claude') throw new Error('expected Claude context');
    expect(context.brokerEnv).toEqual({ PATH: '/bin' });
    expect(context.controllerEnv).toMatchObject({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: TEST_CLAUDE_SOURCE.configDir,
      CORAL_CHILD: '1',
      CORAL_SESSION_ID: 'session-1',
      CORAL_JOB_ID: 'job-1',
    });
    expect(context.projectsRoot).toBe(TEST_CLAUDE_SOURCE.projectsRoot);
  });
});
