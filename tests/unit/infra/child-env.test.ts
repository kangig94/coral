import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock backendLog before importing the module under test
vi.mock('#src/infra/backend-log.js', () => ({
  backendLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), raw: vi.fn() },
}));

import {
  buildChildEnv,
  coralEnvForwardSchema,
  DAEMON_OWNED_CORAL_ENV_KEYS,
  filterForwardableCoralEnv,
  isForwardableCoralEnvKey,
  measureEnv,
  readForwardedCoralEnv,
  resolveEnvBudgetBytes as envBudgetBytes,
  shedInheritedClaudeCodeEnv,
} from '#src/infra/env-sanitize.js';
import { backendLog } from '#src/infra/backend-log.js';

/** Fill env with vars of given size until total exceeds budget. Track size incrementally. */
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

  it('should derive budget from system ARG_MAX', () => {
    const budgetBytes = envBudgetBytes();
    expect(budgetBytes).toBeGreaterThan(0);
    expect(budgetBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
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

  it('should overlay extraEnv and preserve it over base', () => {
    process.env = { PATH: '/usr/bin', MY_VAR: 'old' };

    const result = buildChildEnv({ MY_VAR: 'new', CUSTOM: 'value' });

    expect(result.MY_VAR).toBe('new');
    expect(result.CUSTOM).toBe('value');
    expect(result.CORAL_CHILD).toBe('1');
  });

  it('should allow CORAL_* vars via extraEnv', () => {
    process.env = { PATH: '/usr/bin' };

    const result = buildChildEnv({ CORAL_OWNER: 'session-abc' });

    expect(result.CORAL_OWNER).toBe('session-abc');
    expect(result.CORAL_CHILD).toBe('1');
  });

  it('should pass through all vars when env is under budget', () => {
    process.env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      CFLAGS: '-O2 -Wall -Wextra',
      CMAKE_PREFIX_PATH: '/opt/local:/usr/local',
    };

    const result = buildChildEnv();

    expect(result.PATH).toBe('/usr/bin');
    expect(result.CFLAGS).toBe('-O2 -Wall -Wextra');
    expect(result.CMAKE_PREFIX_PATH).toBe('/opt/local:/usr/local');
    expect(backendLog.warn).not.toHaveBeenCalled();
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

    // Small vars preserved, some bloat vars shed
    expect(result.PATH).toBe('/usr/bin');
    expect(result.SMALL_VAR).toBe('x');
    const keptBloat = Object.keys(result).filter((k) => k.startsWith('BLOAT_')).length;
    expect(keptBloat).toBeGreaterThan(0);
    expect(keptBloat).toBeLessThan(totalBloat);
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('child-env: shed'));
  });

  it('should produce env within budget after shedding', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    fillUntilOverBudget(env, 'VAR', 1024);

    process.env = env;
    const result = buildChildEnv();

    // CORAL_CHILD adds a few bytes — allow small overhead
    expect(measureEnv(result)).toBeLessThanOrEqual(envBudgetBytes() + 64);
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
      // A large var that would normally be shed first
      CRITICAL_BUILD_FLAGS: 'x'.repeat(8192),
      CORAL_ENV_PASSTHROUGH: 'CRITICAL_BUILD_FLAGS',
    };
    fillUntilOverBudget(env, 'FILLER', 512);

    process.env = env;
    const result = buildChildEnv();

    // Protected var survives despite being large
    expect(result.CRITICAL_BUILD_FLAGS).toBe('x'.repeat(8192));
    expect(result.PATH).toBe('/usr/bin');
    expect(backendLog.warn).toHaveBeenCalled();
  });

  it('should log shed var names and passthrough hint', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    fillUntilOverBudget(env, 'BIG', 4096);

    process.env = env;
    buildChildEnv();

    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('CORAL_ENV_PASSTHROUGH'));
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

  it('leaves non-Claude-Code vars untouched (PATH, CORAL_CHILD, auth, near-misses)', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CORAL_CHILD: '1',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDED: 'not-a-claude-code-var',
    };

    shedInheritedClaudeCodeEnv(env);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.CORAL_CHILD).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.CLAUDED).toBe('not-a-claude-code-var');
  });
});

describe('forwardable CORAL_* env', () => {
  it('accepts CORAL_* config keys and rejects non-CORAL keys', () => {
    expect(isForwardableCoralEnvKey('CORAL_CODEX_MODEL')).toBe(true);
    expect(isForwardableCoralEnvKey('CORAL_MAX_WORKERS')).toBe(true);
    expect(isForwardableCoralEnvKey('PATH')).toBe(false);
  });

  it('rejects every daemon-owned key (self-updating if the set grows)', () => {
    for (const key of DAEMON_OWNED_CORAL_ENV_KEYS) {
      expect(isForwardableCoralEnvKey(key)).toBe(false);
    }
  });

  describe('filterForwardableCoralEnv', () => {
    it('keeps forwardable CORAL_* keys and drops daemon-owned, non-CORAL, and empty values', () => {
      const result = filterForwardableCoralEnv({
        CORAL_CODEX_MODEL: 'gpt-5.6-sol',
        CORAL_EFFORT: 'high',
        CORAL_JOB_ID: 'job-1',
        CORAL_CHILD_PRINCIPAL_HANDLE: 'forged',
        CORAL_FLAVOR: 'dev',
        CORAL_EMPTY: '',
        PATH: '/usr/bin',
        UNDEF: undefined,
      });

      expect(result).toEqual({ CORAL_CODEX_MODEL: 'gpt-5.6-sol', CORAL_EFFORT: 'high' });
    });

    it('returns an empty object for an empty input', () => {
      expect(filterForwardableCoralEnv({})).toEqual({});
    });
  });

  describe('readForwardedCoralEnv', () => {
    it('returns undefined for non-object input (absent field)', () => {
      expect(readForwardedCoralEnv(undefined)).toBeUndefined();
      expect(readForwardedCoralEnv(null)).toBeUndefined();
      expect(readForwardedCoralEnv('CORAL_CODEX_MODEL=x')).toBeUndefined();
    });

    it('returns an empty map (not undefined) when a present object filters to nothing', () => {
      // Present-but-empty is authoritative: it must be distinguishable from an
      // absent field so the daemon clears its boot config → provider default.
      expect(readForwardedCoralEnv({})).toEqual({});
      expect(readForwardedCoralEnv({ CORAL_JOB_ID: 'j', PATH: '/usr/bin', CORAL_FLAVOR: 'dev' })).toEqual({});
    });

    it('returns the filtered forwardable config for a valid map', () => {
      expect(readForwardedCoralEnv({ CORAL_CODEX_MODEL: 'gpt-5.6-sol', CORAL_JOB_ID: 'j' })).toEqual({
        CORAL_CODEX_MODEL: 'gpt-5.6-sol',
      });
    });
  });

  describe('coralEnvForwardSchema', () => {
    it('parses a map of non-reserved CORAL_* keys with non-empty values', () => {
      expect(coralEnvForwardSchema.parse({ CORAL_CODEX_MODEL: 'gpt-5.6-sol', CORAL_EFFORT: 'high' })).toEqual({
        CORAL_CODEX_MODEL: 'gpt-5.6-sol',
        CORAL_EFFORT: 'high',
      });
    });

    it('parses an empty map', () => {
      expect(coralEnvForwardSchema.parse({})).toEqual({});
    });

    it('rejects reserved (daemon-owned) keys', () => {
      expect(coralEnvForwardSchema.safeParse({ CORAL_JOB_ID: 'job-1' }).success).toBe(false);
      expect(coralEnvForwardSchema.safeParse({ CORAL_CHILD_PRINCIPAL_HANDLE: 'x' }).success).toBe(false);
      // CORAL_KB_ENABLE is a daemon-boot decision, not a per-request caller knob.
      expect(coralEnvForwardSchema.safeParse({ CORAL_KB_ENABLE: '0' }).success).toBe(false);
    });

    it('rejects the whole map when a reserved key is mixed with a valid one', () => {
      expect(coralEnvForwardSchema.safeParse({ CORAL_EFFORT: 'high', CORAL_JOB_ID: 'forged' }).success).toBe(false);
    });

    it('rejects non-CORAL keys, empty values, and non-string values', () => {
      expect(coralEnvForwardSchema.safeParse({ PATH: '/usr/bin' }).success).toBe(false);
      expect(coralEnvForwardSchema.safeParse({ CORAL_CODEX_MODEL: '' }).success).toBe(false);
      expect(coralEnvForwardSchema.safeParse({ CORAL_EFFORT: 42 }).success).toBe(false);
    });
  });
});
