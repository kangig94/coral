import { describe, expect, it } from 'vitest';

import {
  buildClaudeContinuity,
  mapSessionEnsureParams,
  mapTurnStartParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
} from '#src/providers/claude/request-mapping.js';
import type { ClaudeBootstrapSignature } from '#src/providers/claude/request-prep.js';

const BOOTSTRAP_SIGNATURE: ClaudeBootstrapSignature = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:test',
  permissionMode: 'default',
};

describe('Claude continuity refs', () => {
  it('drops empty persisted refs at the provider boundary', () => {
    expect(
      readClaudePersistedContinuity({
        brokerSessionKey: '',
        envHash: '',
        conversationRef: '',
        brokerTurnId: '',
      }),
    ).toEqual({
      brokerSessionKey: undefined,
      bootstrapSignature: undefined,
      envHash: undefined,
      conversationRef: undefined,
      brokerTurnId: undefined,
    });
  });

  it('drops persisted bootstrap signatures with unknown permission modes', () => {
    expect(
      readClaudePersistedContinuity({
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:test',
          permissionMode: 'unknown',
        },
      }),
    ).toEqual({
      brokerSessionKey: undefined,
      bootstrapSignature: undefined,
      envHash: undefined,
      conversationRef: undefined,
      brokerTurnId: undefined,
    });
  });

  it('builds continuity from non-empty refs only', () => {
    expect(
      buildClaudeContinuity({
        brokerSessionKey: '',
        bootstrapSignature: BOOTSTRAP_SIGNATURE,
        envHash: '',
        conversationRef: '',
        brokerTurnId: '',
      }),
    ).toEqual({
      bootstrapSignature: BOOTSTRAP_SIGNATURE,
    });
  });

  it('preserves canonical persisted refs when an update carries empty strings', () => {
    expect(
      withClaudeContinuity(
        {
          brokerSessionKey: 'broker-1',
          bootstrapSignature: BOOTSTRAP_SIGNATURE,
          envHash: 'env-1',
          conversationRef: 'conversation-1',
          brokerTurnId: 'turn-1',
        },
        {
          brokerSessionKey: '',
          envHash: '',
          conversationRef: '',
          brokerTurnId: '',
        },
      ),
    ).toEqual({
      brokerSessionKey: 'broker-1',
      bootstrapSignature: BOOTSTRAP_SIGNATURE,
      envHash: 'env-1',
      conversationRef: 'conversation-1',
      brokerTurnId: 'turn-1',
    });
  });
});

describe('Claude appserver request mapping', () => {
  it('carries model and effort in session bootstrap while turn/start only sends the prompt', () => {
    const ensure = mapSessionEnsureParams(
      {
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
        model: 'claude-sonnet-4-6',
        effort: 'high',
      },
      { sha256: () => 'system-hash' },
      'system prompt',
    );

    expect(ensure).toMatchObject({
      cwd: '/workspace',
      systemPromptHash: 'sha256:system-hash',
      permissionMode: 'default',
      systemPrompt: 'system prompt',
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });

    expect(mapTurnStartParams('hello', 'broker-1', { uuid: () => 'turn-1' })).toEqual({
      brokerSessionKey: 'broker-1',
      brokerTurnId: 'turn-1',
      prompt: 'hello',
    });
  });
});
