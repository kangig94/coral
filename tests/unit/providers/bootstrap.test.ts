import { describe, expect, it } from 'vitest';

import { createBuiltInProviderRegistry, registerBuiltInProviders } from '#src/providers/bootstrap.js';
import { none } from '#src/providers/capability.js';
import type { ProviderSpec } from '#src/providers/contract.js';
import { defineProvider } from '#src/providers/registry.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { TEST_CLAUDE_SOURCE, TEST_CODEX_SOURCE } from '../../helpers/provider-credentials.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';

function providerNames(providers: ProviderSpec[]): string[] {
  return providers.map((provider) => provider.name);
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
    readFileSync: (path) => files[path] ?? '',
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

type RecoveryLocatorCase = {
  readonly label: string;
  readonly tree: Record<string, DirentLike[]>;
  readonly expected: readonly { readonly handle: string; readonly identity?: Record<string, string> }[] | undefined;
};

describe('registerBuiltInProviders', () => {
  it('registers claude and codex provider specs', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);

    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });

  it('registers the expected facet set for built-in providers', () => {
    const registry = createBuiltInProviderRegistry();
    const claude = registry.get('claude');
    const codex = registry.get('codex');

    expect(claude).toBeDefined();
    expect(typeof claude?.run).toBe('function');
    expect(claude?.appServer).toMatchObject({
      name: 'claude',
      subscriptionPhase: 'beforeInitialize',
    });
    expect(typeof claude?.appServer?.buildServerSpec).toBe('function');
    expect(claude?.appServer?.interrupt).toBeUndefined();
    expect(claude?.recovery?.probe).toBeUndefined();
    expect(typeof claude?.recovery?.finalizeInterrupted).toBe('function');
    expect(typeof claude?.recovery?.finalizeFromArtifacts).toBe('function');
    expect(claude?.artifacts.kind).toBe('managed');

    expect(codex).toBeDefined();
    expect(typeof codex?.run).toBe('function');
    expect(codex?.appServer).toMatchObject({
      name: 'codex',
      subscriptionPhase: 'afterInitialize',
    });
    expect(typeof codex?.appServer?.buildServerSpec).toBe('function');
    expect(typeof codex?.appServer?.interrupt).toBe('function');
    expect(typeof codex?.recovery?.probe).toBe('function');
    expect(typeof codex?.recovery?.finalizeInterrupted).toBe('function');
    expect(typeof codex?.recovery?.finalizeFromArtifacts).toBe('function');
    expect(codex?.artifacts.kind).toBe('managed');
  });

  const codexRecoveryCases: RecoveryLocatorCase[] = [
    {
      label: 'no match',
      tree: {
        '/home/user/.codex/sessions': [dirent('2026', 'dir')],
        '/home/user/.codex/sessions/2026': [dirent('05', 'dir')],
        '/home/user/.codex/sessions/2026/05': [dirent('04', 'dir')],
        '/home/user/.codex/sessions/2026/05/04': [dirent('rollout-a-other-thread.jsonl', 'file')],
      },
      expected: undefined,
    },
    {
      label: 'single match',
      tree: {
        '/home/user/.codex/sessions': [dirent('2026', 'dir')],
        '/home/user/.codex/sessions/2026': [dirent('05', 'dir')],
        '/home/user/.codex/sessions/2026/05': [dirent('04', 'dir')],
        '/home/user/.codex/sessions/2026/05/04': [dirent('rollout-a-thread-from-meta.jsonl', 'file')],
      },
      expected: [
        {
          handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-thread-from-meta.jsonl',
          identity: { kind: 'codex-rollout', threadId: 'thread-from-meta' },
        },
      ],
    },
    {
      label: 'ambiguous match',
      tree: {
        '/home/user/.codex/sessions': [dirent('2026', 'dir')],
        '/home/user/.codex/sessions/2026': [dirent('05', 'dir')],
        '/home/user/.codex/sessions/2026/05': [dirent('04', 'dir')],
        '/home/user/.codex/sessions/2026/05/04': [
          dirent('rollout-a-thread-from-meta.jsonl', 'file'),
          dirent('rollout-b-thread-from-meta.jsonl', 'file'),
        ],
      },
      expected: undefined,
    },
  ];

  it.each(codexRecoveryCases)(
    'finalizeCodexFromArtifacts derives recovery artifact handles from providerMeta/env/storage: $label',
    async ({ tree, expected }) => {
      const codex = createBuiltInProviderRegistry().get('codex');

      const result = await codex?.recovery?.finalizeFromArtifacts({
        source: TEST_CODEX_SOURCE,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        exitCode: 0,
        signal: null,
        providerMeta: { threadId: 'thread-from-meta' },
        fallbackConversationRef: 'fallback-thread',
        storage: recoveryStorage({ tree }),
      });

      expect(result?.artifactHandles).toEqual(expected);
    },
  );

  it('normalizes empty Codex recovery refs before artifact lookup', async () => {
    const codex = createBuiltInProviderRegistry().get('codex');

    const result = await codex?.recovery?.finalizeFromArtifacts({
      source: TEST_CODEX_SOURCE,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: 0,
      signal: null,
      providerMeta: {
        threadId: '',
        providerContinuity: { threadId: '' },
      },
      fallbackConversationRef: 'fallback-thread',
      storage: recoveryStorage({
        tree: {
          '/home/user/.codex/sessions': [dirent('2026', 'dir')],
          '/home/user/.codex/sessions/2026': [dirent('05', 'dir')],
          '/home/user/.codex/sessions/2026/05': [dirent('04', 'dir')],
          '/home/user/.codex/sessions/2026/05/04': [dirent('rollout-a-fallback-thread.jsonl', 'file')],
        },
      }),
    });

    expect(result?.artifactHandles).toEqual([
      {
        handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-fallback-thread.jsonl',
        identity: { kind: 'codex-rollout', threadId: 'fallback-thread' },
      },
    ]);
  });

  const claudeRecoveryCases: RecoveryLocatorCase[] = [
    {
      label: 'no match',
      tree: {
        '/home/user/.claude/projects': [dirent('-workspace', 'dir')],
        '/home/user/.claude/projects/-workspace': [dirent('other-session.jsonl', 'file')],
      },
      expected: undefined,
    },
    {
      label: 'single match',
      tree: {
        '/home/user/.claude/projects': [dirent('-workspace', 'dir')],
        '/home/user/.claude/projects/-workspace': [dirent('conversation-from-meta.jsonl', 'file')],
      },
      expected: [
        {
          handle: '/home/user/.claude/projects/-workspace/conversation-from-meta.jsonl',
          identity: { kind: 'claude-jsonl', conversationRef: 'conversation-from-meta' },
        },
      ],
    },
    {
      label: 'ambiguous match',
      tree: {
        '/home/user/.claude/projects': [dirent('-workspace-a', 'dir'), dirent('-workspace-b', 'dir')],
        '/home/user/.claude/projects/-workspace-a': [dirent('conversation-from-meta.jsonl', 'file')],
        '/home/user/.claude/projects/-workspace-b': [dirent('conversation-from-meta.jsonl', 'file')],
      },
      expected: undefined,
    },
  ];

  it.each(claudeRecoveryCases)(
    'finalizeClaudeFromArtifacts derives recovery artifact handles from providerMeta/env/storage: $label',
    async ({ tree, expected }) => {
      const claude = createBuiltInProviderRegistry().get('claude');

      const result = await claude?.recovery?.finalizeFromArtifacts({
        source: TEST_CLAUDE_SOURCE,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        exitCode: 0,
        signal: null,
        providerMeta: { conversationRef: 'conversation-from-meta' },
        fallbackConversationRef: 'fallback-conversation',
        storage: recoveryStorage({
          files: {
            '/tmp/stdout': JSON.stringify({ type: 'result', result: 'ok' }),
            '/tmp/stderr': '',
          },
          tree,
        }),
      });

      expect(result?.artifactHandles).toEqual(expected);
    },
  );

  it('uses persisted Claude source A and never hostile ambient source B for artifact recovery', async () => {
    const claude = createBuiltInProviderRegistry().get('claude');
    const result = await claude?.recovery?.finalizeFromArtifacts({
      source: {
        version: 1,
        provider: 'claude',
        kind: 'config-dir',
        configDir: '/accounts/claude-a',
        projectsRoot: '/accounts/claude-a/projects',
      },
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: 0,
      signal: null,
      providerMeta: { conversationRef: 'same-conversation' },
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
    const claude = createBuiltInProviderRegistry().get('claude');
    const handle = '/home/user/.claude/projects/-workspace/fresh-conversation.jsonl';
    const result = await claude?.recovery?.finalizeFromArtifacts({
      source: TEST_CLAUDE_SOURCE,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: null,
      signal: null,
      providerMeta: { conversationRef: 'fresh-conversation' },
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
    const claude = createBuiltInProviderRegistry().get('claude');
    const result = await claude?.recovery?.finalizeFromArtifacts({
      source: TEST_CLAUDE_SOURCE,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: null,
      signal: null,
      providerMeta: { conversationRef: 'planned-only' },
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

  it('uses Claude recovery metadata for continuity and artifact lookup without parsing retired stdout', async () => {
    const claude = createBuiltInProviderRegistry().get('claude');

    const result = await claude?.recovery?.finalizeFromArtifacts({
      source: TEST_CLAUDE_SOURCE,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: 0,
      signal: null,
      providerMeta: { conversationRef: 'conversation-from-meta' },
      fallbackConversationRef: 'fallback-conversation',
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

  it('is idempotent per registry instance', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);

    expect(() => registerBuiltInProviders(registry)).not.toThrow();
    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });

  it('fails when a conflicting provider is already registered', () => {
    const registry = new ProviderRegistry();

    registry.register(
      defineProvider({
        name: 'codex',
        run: async function* () {
          yield {
            kind: 'terminal',
            terminal: {
              content: 'conflict',
              outcome: { kind: 'completed' as const },
            },
            diagnostics: {},
          };
        },
      })
        .binding(fixtureProviderBindingCodec('codex'))
        .artifacts(none('conflict fixture declares no provider artifacts'))
        .build(),
    );

    expect(() => registerBuiltInProviders(registry)).toThrow(/already registered/i);
  });
});
