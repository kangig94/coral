import { describe, expect, it, vi } from 'vitest';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { claudeRecoveryLifecycle } from '#src/providers/claude/provider-facets.js';
import {
  claudeArtifactCapability,
  deleteClaudeJsonlArtifactsForConversation,
  locateClaudeJsonlArtifact,
} from '#src/providers/claude/artifacts.js';
import type { ArtifactCleanupRuntime } from '#src/providers/contract.js';

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

describe('claudeRecoveryLifecycle.finalizeInterrupted', () => {
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
      env: { homedir: () => '/home/user' },
    } as unknown as ArtifactCleanupRuntime;

    expect(claudeArtifactCapability.locateArtifact?.('session-1', runtime)).toBe(
      `${root}/-workspace-a/session-1.jsonl`,
    );
    expect(claudeArtifactCapability.locateArtifact?.('missing-session', runtime)).toBeNull();
  });

  it('locateArtifact returns null when the conversationRef is ambiguous across projects', () => {
    const root = '/home/user/.claude/projects';
    const runtime = {
      storage: storageForTree({
        [root]: [dirent('-workspace-a', 'dir'), dirent('-workspace-b', 'dir')],
        [`${root}/-workspace-a`]: [dirent('session-1.jsonl', 'file')],
        [`${root}/-workspace-b`]: [dirent('session-1.jsonl', 'file')],
      }),
      env: { homedir: () => '/home/user' },
    } as unknown as ArtifactCleanupRuntime;

    expect(claudeArtifactCapability.locateArtifact?.('session-1', runtime)).toBeNull();
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
      storage: { unlinkSync },
      env: { homedir: () => '/home/user' },
    } as unknown as ArtifactCleanupRuntime;

    await expect(
      claudeArtifactCapability.discardArtifacts(['/tmp/session-a.jsonl', '/tmp/session-b.jsonl'], runtime),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync.mock.calls).toEqual([['/tmp/session-a.jsonl'], ['/tmp/session-b.jsonl']]);
  });
});
