import { describe, expect, it } from 'vitest';

import { sessionCreateSchema, sessionMessageSchema } from '#src/sessions/command-schemas.js';

describe('session wire schemas', () => {
  it('sessionCreateSchema exposes the documented field set', () => {
    expect(Object.keys(sessionCreateSchema.shape).sort()).toEqual([
      'agent',
      'bypassPermissions',
      'claudeModelCap',
      'effort',
      'model',
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

  it('sessionMessageSchema exposes the documented field set', () => {
    expect(Object.keys(sessionMessageSchema.shape).sort()).toEqual([
      'bypassPermissions',
      'claudeModelCap',
      'effort',
      'model',
      'owner',
      'projectRoot',
      'prompt',
      'provider',
      'systemPrompt',
      'workDir',
    ]);
  });

});
