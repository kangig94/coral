import { describe, expect, it } from 'vitest';

import {
  buildClaudeContinuity,
  readClaudePersistedContinuity,
  withClaudeContinuity,
} from '#src/providers/claude/request-mapping.js';
import type { ClaudeBootstrapSignature } from '#src/providers/claude-appserver/protocol.js';

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
