import { describe, expect, it } from 'vitest';

import { buildControllerEnv } from '#src/transport/invocation-context.js';

const snapshot = Object.freeze({ CORAL_NAMESPACE: 'default' });

describe('buildControllerEnv networkEnv overlay', () => {
  it('overlays recognized proxy/CA vars from the body onto the snapshot', () => {
    const env = buildControllerEnv(
      { networkEnv: { HTTP_PROXY: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: '/c.pem' } },
      snapshot,
    );

    expect(env.CORAL_NAMESPACE).toBe('default');
    expect(env.HTTP_PROXY).toBe('http://proxy:8080');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/c.pem');
  });

  it('ignores unrecognized keys and non-string values in the body', () => {
    const env = buildControllerEnv(
      { networkEnv: { PATH: '/usr/bin', HTTPS_PROXY: 42, NO_PROXY: 'localhost' } },
      snapshot,
    );

    expect(env.PATH).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe('localhost');
  });

  it('drops empty-string values so they do not shadow the daemon setting', () => {
    const env = buildControllerEnv({ networkEnv: { HTTP_PROXY: '', NO_PROXY: 'localhost' } }, snapshot);

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBe('localhost');
  });

  it('still applies transport context identity fields alongside networkEnv', () => {
    const env = buildControllerEnv({ owner: 'sess-1', networkEnv: { HTTP_PROXY: 'http://p:1' } }, snapshot);

    expect(env.CORAL_OWNER).toBe('sess-1');
    expect(env.HTTP_PROXY).toBe('http://p:1');
  });

  it('leaves the env untouched when no networkEnv is present', () => {
    const env = buildControllerEnv({}, snapshot);
    expect(env).toEqual({ CORAL_NAMESPACE: 'default' });
  });
});

describe('buildControllerEnv coralEnv forwarding', () => {
  it('never places the raw named-system provider scope in an invocation environment', () => {
    const env = buildControllerEnv(
      { coralEnv: { CORAL_SYSTEM_PROVIDER_SCOPE: '{"origin":"caller"}' } },
      {
        CORAL_SYSTEM_PROVIDER_SCOPE: '{"origin":"system","name":"private"}',
        CORAL_FLAVOR: 'prod',
      },
    );

    expect(env).toEqual({ CORAL_FLAVOR: 'prod' });
    expect(JSON.stringify(env)).not.toContain('private');
  });

  it('lets the caller override the daemon boot value for a config key', () => {
    const env = buildControllerEnv(
      { coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.6-sol' } },
      { CORAL_CODEX_MODEL: 'gpt-5.5', CORAL_FLAVOR: 'prod' },
    );

    expect(env.CORAL_CODEX_MODEL).toBe('gpt-5.6-sol');
  });

  it('drops a daemon boot config key the caller did not forward (unset → code default)', () => {
    const env = buildControllerEnv({ coralEnv: { CORAL_EFFORT: 'high' } }, { CORAL_CODEX_MODEL: 'gpt-5.5' });

    expect(env).not.toHaveProperty('CORAL_CODEX_MODEL');
    expect(env.CORAL_EFFORT).toBe('high');
  });

  it('re-asserts daemon-owned keys from the snapshot and never takes them from the caller', () => {
    const env = buildControllerEnv(
      { coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.6-sol', CORAL_FLAVOR: 'dev', CORAL_JOB_ID: 'forged' } },
      { CORAL_CODEX_MODEL: 'gpt-5.5', CORAL_FLAVOR: 'prod' },
    );

    expect(env.CORAL_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(env.CORAL_FLAVOR).toBe('prod');
    expect(env).not.toHaveProperty('CORAL_JOB_ID');
  });

  it('keeps the daemon snapshot when no coralEnv field is present (non-participating caller)', () => {
    const env = buildControllerEnv({}, { CORAL_CODEX_MODEL: 'gpt-5.5' });
    expect(env).toEqual({ CORAL_CODEX_MODEL: 'gpt-5.5' });
  });

  it('treats a present-but-empty coralEnv as authoritative — clears daemon config so the provider defaults', () => {
    const env = buildControllerEnv({ coralEnv: {} }, { CORAL_CODEX_MODEL: 'gpt-5.5' });
    expect(env).toEqual({});
  });

  it('clears daemon config when the caller forwards only reserved keys (they filter out to empty)', () => {
    const env = buildControllerEnv({ coralEnv: { CORAL_JOB_ID: 'j' } }, { CORAL_CODEX_MODEL: 'gpt-5.5' });
    expect(env).toEqual({});
  });

  it('never lets a caller override the daemon KB-enable gate (inject reads it per request)', () => {
    const env = buildControllerEnv(
      { coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.6-sol', CORAL_KB_ENABLE: '1' } },
      { CORAL_KB_ENABLE: '0' },
    );
    expect(env.CORAL_KB_ENABLE).toBe('0');
    expect(env.CORAL_CODEX_MODEL).toBe('gpt-5.6-sol');
  });

  it('drops non-string coralEnv values', () => {
    const env = buildControllerEnv(
      { coralEnv: { CORAL_EFFORT: 42 as unknown as string } },
      { CORAL_CODEX_MODEL: 'gpt-5.5' },
    );
    expect(env).not.toHaveProperty('CORAL_EFFORT');
    expect(env).not.toHaveProperty('CORAL_CODEX_MODEL');
  });

  it('applies forwarded coralEnv alongside networkEnv and validated lineage fields', () => {
    const env = buildControllerEnv(
      {
        coralEnv: { CORAL_CODEX_MODEL: 'gpt-5.6-sol' },
        networkEnv: { HTTP_PROXY: 'http://p:1' },
        jobId: 'job-9',
      },
      { CORAL_CODEX_MODEL: 'gpt-5.5', CORAL_FLAVOR: 'prod' },
    );

    expect(env.CORAL_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(env.HTTP_PROXY).toBe('http://p:1');
    expect(env.CORAL_JOB_ID).toBe('job-9');
    expect(env.CORAL_FLAVOR).toBe('prod');
  });
});
