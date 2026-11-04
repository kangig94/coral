import { describe, expect, it } from 'vitest';

import { coralEnvForwardSchema, invocationCoralEnvSnapshot } from '#src/infra/env-sanitize.js';
import { buildControllerEnv } from '#src/transport/invocation-context.js';

describe('failure-domain invocation isolation', () => {
  const placement = {
    CORAL_FAILURE_DOMAIN: '/private/root/coordinator-1',
    CORAL_FAILURE_DOMAIN_ROOT: '/private/root',
    CORAL_FAILURE_DOMAIN_DISPOSITION: 'placed',
    CORAL_FAILURE_DOMAIN_REASON: 'internal-reason',
    CORAL_FAILURE_DOMAIN_REFUSALS: '[{"subject":"coordinator-1","errno":"EACCES"}]',
    CORAL_FAILURE_DOMAIN_FUTURE: 'internal-future-context',
  };

  it('excludes placement context before constructing request environments while retaining the internal snapshot', () => {
    const source = { ...placement, CORAL_FLAVOR: 'prod', CORAL_CODEX_MODEL: 'sol' };
    expect(invocationCoralEnvSnapshot(source)).toEqual({ CORAL_FLAVOR: 'prod', CORAL_CODEX_MODEL: 'sol' });
    expect(buildControllerEnv({}, source)).toEqual({ CORAL_FLAVOR: 'prod', CORAL_CODEX_MODEL: 'sol' });
    expect(source).toEqual({ ...placement, CORAL_FLAVOR: 'prod', CORAL_CODEX_MODEL: 'sol' });
    expect(buildControllerEnv({ coralEnv: placement }, source)).toEqual({ CORAL_FLAVOR: 'prod' });
  });

  it('rejects internal placement keys without advertising them in the public reserved-key message', () => {
    for (const [key, value] of Object.entries(placement)) {
      const parsed = coralEnvForwardSchema.safeParse({ [key]: value });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error(`Accepted internal key: ${key}`);
      for (const issue of parsed.error.issues) {
        expect(issue.message).toContain('CORAL_JOB_ID');
        expect(issue.message).not.toContain('CORAL_FAILURE_DOMAIN');
      }
    }
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
