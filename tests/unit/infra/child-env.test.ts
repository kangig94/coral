import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock coordinatorLog before importing the module under test
vi.mock('#src/infra/coordinator-log.js', () => ({
  coordinatorLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), raw: vi.fn() },
}));

import { buildChildEnv } from '#src/infra/env-sanitize.js';
import { measureEnv, resolveEnvBudgetBytes as envBudgetBytes } from '#src/infra/env-sanitize.js';
import { coordinatorLog } from '#src/infra/coordinator-log.js';

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
    vi.mocked(coordinatorLog.warn).mockReset();
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
    expect(coordinatorLog.warn).not.toHaveBeenCalled();
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
    expect(coordinatorLog.warn).toHaveBeenCalledWith(expect.stringContaining('child-env: shed'));
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
    expect(coordinatorLog.warn).toHaveBeenCalled();
  });

  it('should log shed var names and passthrough hint', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    fillUntilOverBudget(env, 'BIG', 4096);

    process.env = env;
    buildChildEnv();

    expect(coordinatorLog.warn).toHaveBeenCalledWith(expect.stringContaining('CORAL_ENV_PASSTHROUGH'));
  });
});
