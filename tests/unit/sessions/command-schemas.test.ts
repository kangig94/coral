import { describe, expect, it } from 'vitest';

import { sessionCreateSchema, sessionForkSchema, sessionMessageSchema } from '#src/sessions/command-schemas.js';

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
      'systemPrompt',
      'workDir',
    ]);
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

  it('sessionForkSchema exposes the documented field set', () => {
    expect(Object.keys(sessionForkSchema.shape).sort()).toEqual([
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
