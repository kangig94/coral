import { describe, expect, it } from 'vitest';

import {
  buildClaudeChildArgs,
  buildClaudePrintChildArgs,
  createNodeClaudeChildFactory,
} from '#src/providers/claude/appserver/server.js';
import type {
  SpawnClaudeChildOptions,
  SpawnClaudePrintChildOptions,
} from '#src/providers/claude/appserver/session-contract.js';

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';

function spawnOptions(overrides: Partial<SpawnClaudeChildOptions> = {}): SpawnClaudeChildOptions {
  return {
    cwd: '/workspace',
    conversationRef: TEST_SESSION_ID,
    resume: false,
    permissionMode: 'default',
    ...overrides,
  };
}

function printSpawnOptions(overrides: Partial<SpawnClaudePrintChildOptions> = {}): SpawnClaudePrintChildOptions {
  return {
    cwd: '/workspace',
    permissionMode: 'default',
    ...overrides,
  };
}

describe('claude appserver PTY child args', () => {
  it('starts new interactive sessions without stream-json print mode', () => {
    expect(buildClaudeChildArgs(spawnOptions())).toEqual(['--session-id', TEST_SESSION_ID]);
  });

  it('resumes existing sessions and carries bootstrap options at process start', () => {
    expect(
      buildClaudeChildArgs(
        spawnOptions({
          conversationRef: 'session-existing',
          resume: true,
          systemPrompt: 'Stay concise.',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          permissionMode: 'acceptEdits',
        }),
      ),
    ).toEqual([
      '--resume',
      'session-existing',
      '--append-system-prompt',
      'Stay concise.',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('maps auto-allow permission modes to dangerous skip permissions', () => {
    expect(buildClaudeChildArgs(spawnOptions({ permissionMode: 'bypassPermissions' }))).toContain(
      '--dangerously-skip-permissions',
    );
  });

  it('passes auto permission mode through to Claude', () => {
    expect(buildClaudeChildArgs(spawnOptions({ permissionMode: 'auto' }))).toEqual([
      '--session-id',
      TEST_SESSION_ID,
      '--permission-mode',
      'auto',
    ]);
  });

  it('surfaces an actionable provider error when the PTY backend cannot load', async () => {
    const factory = createNodeClaudeChildFactory(process.stderr, async () => {
      throw new Error('Failed to load native module: pty.node');
    });

    const error = await factory(spawnOptions()).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Claude provider unavailable');
    expect((error as Error).message).toContain('Codex');
    expect((error as Error).message).toContain('pty.node');
  });
});

describe('claude appserver print child args', () => {
  it('starts print-mode sessions without a forced session id by default', () => {
    expect(buildClaudePrintChildArgs(printSpawnOptions())).toEqual([
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ]);
  });

  it('resumes existing print-mode sessions and carries bootstrap options', () => {
    expect(
      buildClaudePrintChildArgs(
        printSpawnOptions({
          conversationRef: 'session-existing',
          systemPrompt: 'Stay concise.',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          permissionMode: 'acceptEdits',
        }),
      ),
    ).toEqual([
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--resume',
      'session-existing',
      '--append-system-prompt',
      'Stay concise.',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('maps auto-allow print permission modes to dangerous skip permissions', () => {
    expect(buildClaudePrintChildArgs(printSpawnOptions({ permissionMode: 'bypassPermissions' }))).toContain(
      '--dangerously-skip-permissions',
    );
  });
});
