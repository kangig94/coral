import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildClaudeProviderServerSpec,
  buildClaudeContinuity,
  mapSessionEnsureParams,
  mapTurnStartParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
} from '#src/providers/claude/request-mapping.js';
import type { ClaudeBootstrapSignature } from '#src/providers/claude/request-prep.js';
import { CORAL_CLAUDE_TRANSPORT_ENV } from '#src/providers/claude/transport-mode.js';

const BOOTSTRAP_SIGNATURE: ClaudeBootstrapSignature = {
  cwd: '/workspace',
  systemPromptHash: 'sha256:test',
  permissionMode: 'default',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function withBundleDir<T>(run: () => T): T {
  vi.stubGlobal('__BUNDLE_DIR__', '/plugin/build');
  return run();
}

function withPluginRoot<T>(run: () => T): T {
  vi.stubGlobal('__PLUGIN_ROOT__', '/plugin');
  return run();
}

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

  it('preserves persisted bootstrap signatures with auto permission mode', () => {
    expect(
      readClaudePersistedContinuity({
        bootstrapSignature: {
          cwd: '/workspace',
          systemPromptHash: 'sha256:test',
          permissionMode: 'auto',
        },
      }).bootstrapSignature,
    ).toEqual({
      cwd: '/workspace',
      systemPromptHash: 'sha256:test',
      permissionMode: 'auto',
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
  it('prefers the active bundle appserver when running from build output', () => {
    const spec = withPluginRoot(() =>
      withBundleDir(() =>
        buildClaudeProviderServerSpec(
          { cwd: '/workspace', coralEnv: {} },
          { existsSync: (path) => path === '/plugin/build/coral-claude-appserver.cjs' },
        ),
      ),
    );

    expect(spec.args).toEqual(['/plugin/build/coral-claude-appserver.cjs']);
  });

  it('defaults the Claude broker transport to print mode in provider server identity', () => {
    const spec = withPluginRoot(() =>
      buildClaudeProviderServerSpec({ cwd: '/workspace', coralEnv: {} }, { existsSync: () => true }),
    );

    expect(spec.env).toEqual({ [CORAL_CLAUDE_TRANSPORT_ENV]: 'print' });
  });

  it('carries explicit TUI transport into provider server identity', () => {
    const spec = withPluginRoot(() =>
      buildClaudeProviderServerSpec(
        { cwd: '/workspace', coralEnv: { [CORAL_CLAUDE_TRANSPORT_ENV]: 'tui' } },
        { existsSync: () => true },
      ),
    );

    expect(spec.env).toEqual({ [CORAL_CLAUDE_TRANSPORT_ENV]: 'tui' });
  });

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
