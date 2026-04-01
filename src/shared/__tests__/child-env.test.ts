import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock backendLog before importing the module under test
vi.mock('../backend-log.js', () => ({
  backendLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), raw: vi.fn() },
}));

import { buildChildEnv } from '../child-env.js';
import { backendLog } from '../backend-log.js';

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
      CORAL_MAX_SESSIONS: '10',
      CORAL_DISCUSS_MAX_SESSIONS: '5',
    };

    const result = buildChildEnv();

    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.CORAL_CHILD).toBe('1');
    expect(result).not.toHaveProperty('CORAL_MAX_SESSIONS');
    expect(result).not.toHaveProperty('CORAL_DISCUSS_MAX_SESSIONS');
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

  it('should pass through all vars when env is small (under budget)', () => {
    process.env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      CUSTOM_APP_VAR: 'value',
      BUILD_TOOL_FLAG: 'true',
    };

    const result = buildChildEnv();

    expect(result.PATH).toBe('/usr/bin');
    expect(result.CUSTOM_APP_VAR).toBe('value');
    expect(result.BUILD_TOOL_FLAG).toBe('true');
    expect(backendLog.warn).not.toHaveBeenCalled();
  });

  it('should shed tier 1 (k8s service discovery) when over budget', () => {
    // Create a bloated env dominated by k8s service discovery vars
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      HOME: '/home/user',
    };

    // Generate ~100KB of k8s service discovery vars
    for (let i = 0; i < 500; i++) {
      const svc = `SVC${String(i).padStart(3, '0')}`;
      env[`${svc}_SERVICE_HOST`] = `10.0.${Math.floor(i / 256)}.${i % 256}`;
      env[`${svc}_SERVICE_PORT`] = '8080';
      env[`${svc}_PORT`] = `tcp://10.0.${Math.floor(i / 256)}.${i % 256}:8080`;
      env[`${svc}_PORT_8080_TCP`] = `tcp://10.0.${Math.floor(i / 256)}.${i % 256}:8080`;
      env[`${svc}_PORT_8080_TCP_PROTO`] = 'tcp';
      env[`${svc}_PORT_8080_TCP_PORT`] = '8080';
      env[`${svc}_PORT_8080_TCP_ADDR`] = `10.0.${Math.floor(i / 256)}.${i % 256}`;
    }
    // Also add KUBERNETES_ vars
    env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    env.KUBERNETES_SERVICE_PORT = '443';
    env.KUBERNETES_PORT = 'tcp://10.0.0.1:443';

    process.env = env;

    const result = buildChildEnv();

    // Essential vars preserved
    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.CORAL_CHILD).toBe('1');

    // k8s vars removed
    expect(result).not.toHaveProperty('SVC000_SERVICE_HOST');
    expect(result).not.toHaveProperty('SVC000_PORT_8080_TCP');
    expect(result).not.toHaveProperty('KUBERNETES_SERVICE_HOST');

    // Shedding was logged
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('child-env: shed'));
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('tier1(k8s)'));
  });

  it('should shed tier 2 (large values) when tier 1 is insufficient', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      HOME: '/home/user',
    };

    // Add large non-k8s vars (5KB each) to exceed budget
    for (let i = 0; i < 25; i++) {
      env[`MOUNTED_SECRET_${i}`] = 'x'.repeat(5 * 1024);
    }

    process.env = env;

    const result = buildChildEnv();

    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
    // Large vars should be shed
    expect(result).not.toHaveProperty('MOUNTED_SECRET_0');
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('tier2(large)'));
  });

  it('should shed tier 3 (by descending size) as last resort', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      SMALL_VAR: 'x',
    };

    // Add many medium-sized vars (2KB each, under tier 2 threshold) to exceed budget
    for (let i = 0; i < 60; i++) {
      env[`MEDIUM_VAR_${i}`] = 'y'.repeat(2 * 1024);
    }

    process.env = env;

    const result = buildChildEnv();

    expect(result.PATH).toBe('/usr/bin');
    expect(result.SMALL_VAR).toBe('x');
    // Some medium vars shed, but not all
    const mediumCount = Object.keys(result).filter((k) => k.startsWith('MEDIUM_VAR_')).length;
    expect(mediumCount).toBeGreaterThan(0);
    expect(mediumCount).toBeLessThan(60);
    expect(backendLog.warn).toHaveBeenCalledWith(expect.stringContaining('tier3(by-size)'));
  });

  it('should never shed extraEnv entries', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };

    // Fill base env to exceed budget
    for (let i = 0; i < 500; i++) {
      const svc = `SVC${String(i).padStart(3, '0')}`;
      env[`${svc}_SERVICE_HOST`] = `10.0.${Math.floor(i / 256)}.${i % 256}`;
      env[`${svc}_SERVICE_PORT`] = '8080';
    }

    process.env = env;

    const result = buildChildEnv({ IMPORTANT_KEY: 'must-survive', OPENAI_API_KEY: 'sk-test' });

    expect(result.IMPORTANT_KEY).toBe('must-survive');
    expect(result.OPENAI_API_KEY).toBe('sk-test');
    expect(result.CORAL_CHILD).toBe('1');
  });
});
