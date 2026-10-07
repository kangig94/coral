import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/infra/backend-log.js', () => ({
  backendLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), raw: vi.fn() },
}));

import {
  buildChildEnv,
  filterForwardableCoralEnv,
  measureEnv,
  resolveEnvBudgetBytes as envBudgetBytes,
  shedInheritedClaudeCodeEnv,
} from '#src/infra/env-sanitize.js';
import { backendLog } from '#src/infra/backend-log.js';

function fillUntilOverBudget(env: Record<string, string>, prefix: string, valueSize: number): void {
  const budgetBytes = envBudgetBytes();
  let size = measureEnv(env);
  for (let i = 0; size <= budgetBytes; i++) {
    const k = `${prefix}_${i}`;
    const v = 'x'.repeat(valueSize);
    env[k] = v;
    size += k.length + 1 + v.length + 1;
  }
}

describe('buildChildEnv', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    vi.mocked(backendLog.warn).mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should strip CORAL_* vars from base env and set CORAL_CHILD', () => {
    process.env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      CORAL_MAX_WORKERS: '10',
      CORAL_DISCUSS_MAX_WORKERS: '5',
    };

    const result = buildChildEnv();

    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.CORAL_CHILD).toBe('1');
    expect(result).not.toHaveProperty('CORAL_MAX_WORKERS');
    expect(result).not.toHaveProperty('CORAL_DISCUSS_MAX_WORKERS');
  });

  it('should shed largest vars first when over budget', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      SMALL_VAR: 'x',
    };
    fillUntilOverBudget(env, 'BLOAT', 2048);
    const totalBloat = Object.keys(env).filter((k) => k.startsWith('BLOAT_')).length;

    process.env = env;
    const result = buildChildEnv();

    expect(result.PATH).toBe('/usr/bin');
    expect(result.SMALL_VAR).toBe('x');
    const keptBloat = Object.keys(result).filter((k) => k.startsWith('BLOAT_')).length;
    expect(keptBloat).toBeGreaterThan(0);
    expect(keptBloat).toBeLessThan(totalBloat);
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('child-env: shed'));
  });

  it('should never shed extraEnv entries', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    fillUntilOverBudget(env, 'FILLER', 512);

    process.env = env;
    const result = buildChildEnv({ IMPORTANT_KEY: 'must-survive', OPENAI_API_KEY: 'sk-test' });

    expect(result.IMPORTANT_KEY).toBe('must-survive');
    expect(result.OPENAI_API_KEY).toBe('sk-test');
    expect(result.CORAL_CHILD).toBe('1');
  });

  it('should respect CORAL_ENV_PASSTHROUGH to protect specific vars', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      CRITICAL_BUILD_FLAGS: 'x'.repeat(8192),
      CORAL_ENV_PASSTHROUGH: 'CRITICAL_BUILD_FLAGS',
    };
    fillUntilOverBudget(env, 'FILLER', 512);

    process.env = env;
    const result = buildChildEnv();

    expect(result.CRITICAL_BUILD_FLAGS).toBe('x'.repeat(8192));
    expect(result.PATH).toBe('/usr/bin');
    expect(backendLog.warn).toHaveBeenCalled();
  });
});

describe('shedInheritedClaudeCodeEnv', () => {
  it('deletes CLAUDECODE and the CLAUDE_* family in place', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_ENV_FILE: '/tmp/x.sh',
      CLAUDE_PLUGIN_ROOT: '/plugins',
    };

    shedInheritedClaudeCodeEnv(env);

    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(env).not.toHaveProperty('CLAUDE_ENV_FILE');
    expect(env).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
  });

  it('preserves CLAUDE_CONFIG_DIR while shedding the rest of the CLAUDE_* family', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
    };

    shedInheritedClaudeCodeEnv(env);

    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    // The daemon is config-dir-isolated: it needs CLAUDE_CONFIG_DIR to resolve
    // its .claude paths + state slot, and forwards it to spawned claude children.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-work');
  });
});

describe('forwardable CORAL_* env', () => {
  describe('filterForwardableCoralEnv', () => {
    it('keeps forwardable CORAL_* keys and drops daemon-owned, non-CORAL, and empty values', () => {
      const result = filterForwardableCoralEnv({
        CORAL_CODEX_MODEL: 'gpt-5.6-sol',
        CORAL_EFFORT: 'high',
        CORAL_JOB_ID: 'job-1',
        CORAL_CHILD_PRINCIPAL_HANDLE: 'forged',
        CORAL_SYSTEM_PROVIDER_SCOPE: '{"origin":"system","name":"private"}',
        CORAL_FLAVOR: 'dev',
        CORAL_EMPTY: '',
        PATH: '/usr/bin',
        UNDEF: undefined,
      });
      expect(result).not.toHaveProperty('CORAL_SYSTEM_PROVIDER_SCOPE');

      expect(result).toEqual({ CORAL_CODEX_MODEL: 'gpt-5.6-sol', CORAL_EFFORT: 'high' });
    });
  });
});

it('does not forward CLI handoff state into a nested job', () => {
  expect(
    filterForwardableCoralEnv({
      CORAL_CLI_HANDOFF_DELEGATED: '1',
      CORAL_WAIT_INVOCATION_CONTEXT: '{}',
      CORAL_JOBS_RETENTION_DAYS: '14',
    }),
  ).toEqual({ CORAL_JOBS_RETENTION_DAYS: '14' });
});
