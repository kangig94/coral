import { describe, expect, it } from 'vitest';

import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import type { ProviderBindingEnvelope } from '#src/infra/provider-binding-envelope.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { TEST_CLAUDE_BINDING } from '../../helpers/provider-credentials.js';

function boundBuiltIn(provider: 'claude', envelope: ProviderBindingEnvelope = TEST_CLAUDE_BINDING): BoundProvider {
  const result = createBuiltInProviderRegistry().rehydrateBinding(envelope);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected ${provider} binding failure: ${result.failure.reason}`);
  expect(result.value.name).toBe(provider);
  return result.value;
}

function dirent(name: string, kind: 'file' | 'dir'): DirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function recoveryStorage(options: {
  readonly files?: Record<string, string>;
  readonly tree?: Record<string, DirentLike[]>;
}): Pick<StoragePort, 'readFileSync' | 'existsSync' | 'readdirSync' | 'statSync'> {
  const files = options.files ?? {};
  const tree = options.tree ?? {};
  return {
    readFileSync: (path) => files[String(path)] ?? '',
    existsSync: (path) => Object.prototype.hasOwnProperty.call(tree, path),
    readdirSync: ((path: string) => tree[path] ?? []) as unknown as StoragePort['readdirSync'],
    statSync: (() => ({
      size: 0,
      mtimeMs: 0,
      isDirectory: () => false,
      isFile: () => true,
    })) as unknown as StoragePort['statSync'],
  };
}

describe('registerBuiltInProviders', () => {
  it('uses persisted Claude source A and never hostile ambient source B for artifact recovery', async () => {
    const claude = boundBuiltIn('claude', {
      provider: 'claude',
      kind: 'profile',
      binding: {
        profile: {
          canonicalLocation: '/accounts/claude-a',
          routing: { kind: 'config-dir', emitConfigDir: true },
        },
        guarantee: 'profile-only',
      },
    });
    const result = await claude.recovery?.finalizeFromArtifacts({
      durationMs: 0,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: 0,
      signal: null,
      fallbackConversationRef: 'same-conversation',
      storage: recoveryStorage({
        files: { '/tmp/stdout': '', '/tmp/stderr': '' },
        tree: {
          '/accounts/claude-a/projects': [dirent('-workspace', 'dir')],
          '/accounts/claude-a/projects/-workspace': [dirent('same-conversation.jsonl', 'file')],
          '/accounts/claude-b/.claude/projects': [dirent('-workspace', 'dir')],
          '/accounts/claude-b/.claude/projects/-workspace': [dirent('same-conversation.jsonl', 'file')],
        },
      }),
    });

    expect(result?.artifactHandles).toEqual([
      {
        handle: '/accounts/claude-a/projects/-workspace/same-conversation.jsonl',
        identity: { kind: 'claude-jsonl', conversationRef: 'same-conversation' },
      },
    ]);
  });

  it('recovers a fresh Claude session from its durable preassigned conversation reference', async () => {
    const claude = boundBuiltIn('claude');
    const handle = '/home/user/.claude/projects/-workspace/fresh-conversation.jsonl';
    const result = await claude.recovery?.finalizeFromArtifacts({
      durationMs: 0,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: null,
      signal: null,
      fallbackConversationRef: 'fresh-conversation',
      storage: recoveryStorage({
        files: { '/tmp/stdout': '', '/tmp/stderr': '' },
        tree: {
          '/home/user/.claude/projects': [dirent('-workspace', 'dir')],
          '/home/user/.claude/projects/-workspace': [dirent('fresh-conversation.jsonl', 'file')],
        },
      }),
    });

    expect(result).toMatchObject({
      continuity: { conversationRef: 'fresh-conversation', resumable: true },
      artifactHandles: [
        {
          handle,
          identity: { kind: 'claude-jsonl', conversationRef: 'fresh-conversation' },
        },
      ],
    });
  });

  it('does not treat a planned Claude conversation reference as resumable without its exact JSONL', async () => {
    const claude = boundBuiltIn('claude');
    const result = await claude.recovery?.finalizeFromArtifacts({
      durationMs: 0,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: null,
      signal: null,
      fallbackConversationRef: 'planned-only',
      storage: recoveryStorage({
        files: { '/tmp/stdout': '', '/tmp/stderr': '' },
        tree: {
          '/home/user/.claude/projects': [dirent('-workspace', 'dir')],
          '/home/user/.claude/projects/-workspace': [dirent('unrelated.jsonl', 'file')],
        },
      }),
    });

    expect(result?.artifactHandles).toBeUndefined();
    expect(result?.continuity).toEqual({ conversationRef: null, resumable: false });
  });

  it('uses the session conversation reference without parsing retired stdout', async () => {
    const claude = boundBuiltIn('claude');

    const result = await claude.recovery?.finalizeFromArtifacts({
      durationMs: 0,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: 0,
      signal: null,
      fallbackConversationRef: 'conversation-from-meta',
      storage: recoveryStorage({
        files: {
          '/tmp/stdout': JSON.stringify({ type: 'result', result: 'ok', session_id: '' }),
          '/tmp/stderr': '',
        },
        tree: {
          '/home/user/.claude/projects': [dirent('-workspace', 'dir')],
          '/home/user/.claude/projects/-workspace': [dirent('conversation-from-meta.jsonl', 'file')],
        },
      }),
    });

    expect(result?.continuity).toEqual({
      conversationRef: 'conversation-from-meta',
      resumable: true,
    });
    expect(result?.artifactHandles).toEqual([
      {
        handle: '/home/user/.claude/projects/-workspace/conversation-from-meta.jsonl',
        identity: { kind: 'claude-jsonl', conversationRef: 'conversation-from-meta' },
      },
    ]);
  });
});
