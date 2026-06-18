import { describe, expect, it } from 'vitest';

import { sessionCreateSchema } from '#src/sessions/command-schemas.js';

describe('session wire schemas', () => {
  it('sessionCreateSchema exposes the documented field set', () => {
    expect(Object.keys(sessionCreateSchema.shape).sort()).toEqual([
      'agent',
      'bypassPermissions',
      'claudeModelCap',
      'effort',
      'model',
      'networkEnv',
      'owner',
      'projectRoot',
      'prompt',
      'provider',
      'retention',
      'systemPrompt',
      'workDir',
    ]);
  });

  it('sessionCreateSchema strictly validates retention policy values', () => {
    expect(
      sessionCreateSchema.parse({
        provider: 'codex',
        prompt: 'hello',
        projectRoot: '/tmp/project',
        retention: 'discard_provider_artifacts_on_terminal',
      }).retention,
    ).toBe('discard_provider_artifacts_on_terminal');

    expect(() =>
      sessionCreateSchema.parse({
        provider: 'codex',
        prompt: 'hello',
        projectRoot: '/tmp/project',
        retention: 'discard',
      }),
    ).toThrow();
  });

  it('sessionCreateSchema accepts a known networkEnv map and rejects unknown keys', () => {
    expect(
      sessionCreateSchema.parse({
        provider: 'claude',
        prompt: 'hello',
        projectRoot: '/tmp/project',
        networkEnv: { HTTP_PROXY: 'http://p:1' },
      }).networkEnv,
    ).toEqual({ HTTP_PROXY: 'http://p:1' });

    expect(() =>
      sessionCreateSchema.parse({
        provider: 'claude',
        prompt: 'hello',
        projectRoot: '/tmp/project',
        networkEnv: { PATH: '/usr/bin' },
      }),
    ).toThrow();
  });
});
