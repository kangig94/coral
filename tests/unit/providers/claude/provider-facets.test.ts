import { describe, expect, it, vi } from 'vitest';
import { TEST_CLAUDE_SOURCE } from '../../../helpers/provider-credentials.js';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { claudePreflight, claudeRecoveryLifecycle } from '#src/providers/claude/provider-facets.js';
import {
  claudeArtifactCapability,
  deleteClaudeJsonlArtifactsForConversation,
  locateClaudeJsonlArtifact,
} from '#src/providers/claude/artifacts.js';
import type { ArtifactCleanupRuntime, ProviderPreflightRuntime } from '#src/providers/contract.js';

function claudePreflightRuntime(files: Readonly<Record<string, string>>): ProviderPreflightRuntime {
  const runExact = vi.fn(async (_command: string, args: string[]) =>
    args[0] === '--version'
      ? { stdout: 'claude 1.0.0', stderr: '', status: 0, signal: null }
      : { stdout: JSON.stringify({ authenticated: true }), stderr: '', status: 0, signal: null },
  );
  return {
    credentialSource: TEST_CLAUDE_SOURCE,
    cwd: '/workspace/project',
    storage: {
      existsSync: (path: string) => Object.hasOwn(files, path),
      readFileSync: (path: string) => files[path] ?? '',
    },
    runExact,
  } as unknown as ProviderPreflightRuntime;
}

function dirent(name: string, kind: 'file' | 'dir'): DirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function storageForTree(tree: Record<string, DirentLike[]>): Pick<StoragePort, 'existsSync' | 'readdirSync'> {
  return {
    existsSync: (path) => Object.prototype.hasOwnProperty.call(tree, path),
    readdirSync: ((path: string) => tree[path] ?? []) as unknown as StoragePort['readdirSync'],
  };
}

describe('claudePreflight', () => {
  it.each([
    ['account settings', '/home/user/.claude/settings.json'],
    ['project settings', '/workspace/project/.claude/settings.json'],
    ['local project settings', '/workspace/project/.claude/settings.local.json'],
    ['parent project settings', '/workspace/.claude/settings.json'],
  ])('rejects external-provider selectors from %s before probing Claude', async (_label, settingsPath) => {
    const runtime = claudePreflightRuntime({
      [settingsPath]: JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }),
    });

    await expect(claudePreflight(runtime)).rejects.toThrow(
      `Unsupported Claude credential selector 'CLAUDE_CODE_USE_BEDROCK' in '${settingsPath}'`,
    );
    expect(runtime.runExact).not.toHaveBeenCalled();
  });

  it('rejects case-variant external-provider selectors', async () => {
    const settingsPath = '/workspace/project/.claude/settings.json';
    const runtime = claudePreflightRuntime({
      [settingsPath]: JSON.stringify({ env: { claude_code_use_bedrock: '1' } }),
    });

    await expect(claudePreflight(runtime)).rejects.toThrow(
      `Unsupported Claude credential selector 'claude_code_use_bedrock' in '${settingsPath}'`,
    );
    expect(runtime.runExact).not.toHaveBeenCalled();
  });

  it.each(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'])(
    'rejects the %s credential helper from the selected source',
    async (helper) => {
      const settingsPath = '/home/user/.claude/settings.json';
      const runtime = claudePreflightRuntime({ [settingsPath]: JSON.stringify({ [helper]: '/usr/bin/helper' }) });

      await expect(claudePreflight(runtime)).rejects.toThrow(
        `Unsupported Claude credential helper '${helper}' in '${settingsPath}'`,
      );
      expect(runtime.runExact).not.toHaveBeenCalled();
    },
  );

  it('probes Claude when selected and project settings contain no unsupported credential mode', async () => {
    const runtime = claudePreflightRuntime({
      '/home/user/.claude/settings.json': JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' } }),
    });

    await expect(claudePreflight(runtime)).resolves.toBeUndefined();
    expect(runtime.runExact).toHaveBeenCalledTimes(2);
  });
});

describe('claudeRecoveryLifecycle.finalizeInterrupted', () => {
  it('preassigns a fresh conversation reference from the durable Coral session id', () => {
    expect(
      claudeRecoveryLifecycle.buildRecoveryMeta({
        action: 'exec',
        sessionId: 'coral-session-1',
        prompt: 'hello',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      }),
    ).toEqual({ conversationRef: 'coral-session-1' });
  });

  it('uses the preserved conversation ref when the session is resumable without a bootstrap signature', () => {
    const mutation = claudeRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: {
          brokerSessionKey: 'broker-1',
        },
      },
      {
        brokerSessionKey: 'broker-1',
      },
      { preservedConversationRef: 'ref-x' },
    );

    expect(mutation).toEqual({
      kind: 'set_resumable',
      conversationRef: 'ref-x',
    });
  });

  it('preserves continuity when the session is resumable but there is no effective conversation ref to write', () => {
    const mutation = claudeRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: {
          brokerSessionKey: 'broker-1',
        },
      },
      {
        brokerSessionKey: 'broker-1',
      },
      {},
    );

    expect(mutation).toEqual({
      kind: 'preserve',
    });
  });
});

describe('locateClaudeJsonlArtifact', () => {
  const root = '/home/user/.claude/projects';

  it('returns no_match when no project JSONL matches the conversation ref', () => {
    const storage = storageForTree({
      [root]: [dirent('-workspace-a', 'dir')],
      [`${root}/-workspace-a`]: [dirent('other-session.jsonl', 'file')],
    });

    expect(locateClaudeJsonlArtifact({ conversationRef: 'session-1', projectsRoot: root, storage })).toMatchObject({
      kind: 'no_match',
      diagnostic: expect.stringContaining('session-1'),
    });
  });

  it('returns the concrete project JSONL path for a single conversation ref match', () => {
    const storage = storageForTree({
      [root]: [dirent('-workspace-a', 'dir')],
      [`${root}/-workspace-a`]: [dirent('session-1.jsonl', 'file')],
    });

    expect(locateClaudeJsonlArtifact({ conversationRef: 'session-1', projectsRoot: root, storage })).toEqual({
      kind: 'match',
      artifact: {
        handle: `${root}/-workspace-a/session-1.jsonl`,
        identity: { kind: 'claude-jsonl', conversationRef: 'session-1' },
      },
    });
  });

  it('returns ambiguous when multiple project JSONL files match the conversation ref', () => {
    const storage = storageForTree({
      [root]: [dirent('-workspace-a', 'dir'), dirent('-workspace-b', 'dir')],
      [`${root}/-workspace-a`]: [dirent('session-1.jsonl', 'file')],
      [`${root}/-workspace-b`]: [dirent('session-1.jsonl', 'file')],
    });

    expect(locateClaudeJsonlArtifact({ conversationRef: 'session-1', projectsRoot: root, storage })).toMatchObject({
      kind: 'ambiguous',
      diagnostic: expect.stringContaining('2 JSONL'),
      matches: [`${root}/-workspace-a/session-1.jsonl`, `${root}/-workspace-b/session-1.jsonl`],
    });
  });
});

describe('claudeArtifactCapability', () => {
  it('locateArtifact resolves the project JSONL handle for a known conversationRef from the runtime', () => {
    const root = '/home/user/.claude/projects';
    const runtime = {
      storage: storageForTree({
        [root]: [dirent('-workspace-a', 'dir')],
        [`${root}/-workspace-a`]: [dirent('session-1.jsonl', 'file')],
      }),
      env: { homedir: () => '/home/user', claudeConfigDir: () => '/home/user/.claude' },
    } as unknown as ArtifactCleanupRuntime;

    expect(
      claudeArtifactCapability.locateArtifact?.({ conversationRef: 'session-1', source: TEST_CLAUDE_SOURCE, runtime }),
    ).toBe(`${root}/-workspace-a/session-1.jsonl`);
    expect(
      claudeArtifactCapability.locateArtifact?.({
        conversationRef: 'missing-session',
        source: TEST_CLAUDE_SOURCE,
        runtime,
      }),
    ).toBeNull();
  });

  it('locateArtifact returns null when the conversationRef is ambiguous across projects', () => {
    const root = '/home/user/.claude/projects';
    const runtime = {
      storage: storageForTree({
        [root]: [dirent('-workspace-a', 'dir'), dirent('-workspace-b', 'dir')],
        [`${root}/-workspace-a`]: [dirent('session-1.jsonl', 'file')],
        [`${root}/-workspace-b`]: [dirent('session-1.jsonl', 'file')],
      }),
      env: { homedir: () => '/home/user', claudeConfigDir: () => '/home/user/.claude' },
    } as unknown as ArtifactCleanupRuntime;

    expect(
      claudeArtifactCapability.locateArtifact?.({ conversationRef: 'session-1', source: TEST_CLAUDE_SOURCE, runtime }),
    ).toBeNull();
  });
});

describe('deleteClaudeJsonlArtifactsForConversation', () => {
  const root = '/home/user/.claude/projects';

  it('deletes every ambiguous JSONL match for one-shot curate sessions', () => {
    const unlinkSync = vi.fn();
    const storage = {
      ...storageForTree({
        [root]: [dirent('-workspace-a', 'dir'), dirent('-workspace-b', 'dir')],
        [`${root}/-workspace-a`]: [dirent('session-1.jsonl', 'file')],
        [`${root}/-workspace-b`]: [dirent('session-1.jsonl', 'file')],
      }),
      unlinkSync,
    };

    expect(
      deleteClaudeJsonlArtifactsForConversation({
        conversationRef: 'session-1',
        projectsRoot: root,
        storage,
      }),
    ).toEqual({
      deleted: [`${root}/-workspace-a/session-1.jsonl`, `${root}/-workspace-b/session-1.jsonl`],
      missing: false,
      errors: [],
    });
    expect(unlinkSync.mock.calls).toEqual([
      [`${root}/-workspace-a/session-1.jsonl`],
      [`${root}/-workspace-b/session-1.jsonl`],
    ]);
  });
});

describe('claudeArtifactCapability', () => {
  it('discards only the recorded handles it is given', async () => {
    const unlinkSync = vi.fn();
    const runtime = {
      storage: { unlinkSync, existsSync: () => false },
      env: { homedir: () => '/home/user', claudeConfigDir: () => '/home/user/.claude' },
      time: { sleep: async () => {} },
    } as unknown as ArtifactCleanupRuntime;

    await expect(
      claudeArtifactCapability.discardArtifacts({
        handles: ['/tmp/session-a.jsonl', '/tmp/session-b.jsonl'],
        source: TEST_CLAUDE_SOURCE,
        runtime,
      }),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync.mock.calls).toEqual([['/tmp/session-a.jsonl'], ['/tmp/session-b.jsonl']]);
  });
});
