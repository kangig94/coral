import { describe, expect, it } from 'vitest';

import { createBuiltInProviderRegistry, registerBuiltInProviders } from '#src/providers/bootstrap.js';
import { none } from '#src/providers/capability.js';
import type { ProviderRequest } from '#src/providers/contract.js';
import type { ProviderBindingEnvelope } from '#src/infra/provider-binding-envelope.js';
import { defineProvider } from '#src/providers/registry.js';
import { ProviderRegistry, type ProviderDefinition } from '#src/providers/registry.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { TEST_CLAUDE_BINDING, TEST_CODEX_BINDING } from '../../helpers/provider-credentials.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';

function providerNames(providers: ProviderDefinition[]): string[] {
  return providers.map((provider) => provider.name);
}

function boundBuiltIn(
  provider: 'claude' | 'codex',
  envelope: ProviderBindingEnvelope = provider === 'claude' ? TEST_CLAUDE_BINDING : TEST_CODEX_BINDING,
): BoundProvider {
  const result = createBuiltInProviderRegistry().rehydrateBinding(envelope);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected ${provider} binding failure: ${result.failure.reason}`);
  expect(result.value.name).toBe(provider);
  return result.value;
}

function request(provider: 'claude' | 'codex'): ProviderRequest {
  return {
    action: 'exec',
    sessionId: `${provider}-session`,
    prompt: 'test',
    cwd: '/workspace',
    bypassPermissions: false,
    coralEnv: {},
  };
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

  it('keeps built-in definitions name-only and exposes facets only after binding', () => {
    const registry = createBuiltInProviderRegistry();
    const claudeDefinition = registry.get('claude');
    const codexDefinition = registry.get('codex');

    for (const definition of [claudeDefinition, codexDefinition]) {
      expect(definition).toBeDefined();
      expect(definition).not.toHaveProperty('run');
      expect(definition).not.toHaveProperty('preflight');
      expect(definition).not.toHaveProperty('appServer');
      expect(definition).not.toHaveProperty('recovery');
      expect(definition).not.toHaveProperty('artifacts');
    }

    const claude = boundBuiltIn('claude');
    const codex = boundBuiltIn('codex');
    const preparedClaude = claude.prepareExecution({
      request: request('claude'),
      baseEnv: {},
      platform: 'linux',
    });
    const preparedCodex = codex.prepareExecution({
      request: request('codex'),
      baseEnv: {},
      platform: 'linux',
    });

    expect(preparedClaude.appServer).toMatchObject({
      name: 'claude',
      subscriptionPhase: 'beforeInitialize',
    });
    expect(typeof preparedClaude.appServer?.buildServerSpec).toBe('function');
    expect(preparedClaude.appServer?.interrupt).toBeUndefined();
    expect(claude.recovery?.probe).toBeUndefined();
    expect(typeof claude.recovery?.finalizeInterrupted).toBe('function');
    expect(typeof claude.recovery?.finalizeFromArtifacts).toBe('function');
    expect(claude.artifacts.kind).toBe('managed');

    expect(preparedCodex.appServer).toMatchObject({
      name: 'codex',
      subscriptionPhase: 'afterInitialize',
    });
    expect(typeof preparedCodex.appServer?.buildServerSpec).toBe('function');
    expect(typeof preparedCodex.appServer?.interrupt).toBe('function');
    expect(typeof codex.recovery?.probe).toBe('function');
    expect(typeof codex.recovery?.finalizeInterrupted).toBe('function');
    expect(typeof codex.recovery?.finalizeFromArtifacts).toBe('function');
    expect(codex.artifacts.kind).toBe('managed');
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
    'finalizeCodexFromArtifacts derives recovery artifact handles from the session reference: $label',
    async ({ tree, expected }) => {
      const codex = boundBuiltIn('codex');

      const result = await codex.recovery?.finalizeFromArtifacts({
        durationMs: 0,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        exitCode: 0,
        signal: null,
        fallbackConversationRef: 'thread-from-meta',
        storage: recoveryStorage({ tree }),
      });

      expect(result?.artifactHandles).toEqual(expected);
    },
  );

  it('uses the session conversation reference for Codex artifact lookup', async () => {
    const codex = boundBuiltIn('codex');

    const result = await codex.recovery?.finalizeFromArtifacts({
      durationMs: 0,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      exitCode: 0,
      signal: null,
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
    'finalizeClaudeFromArtifacts derives recovery artifact handles from the session reference: $label',
    async ({ tree, expected }) => {
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
        prepareExecutionContext: () => ({ context: undefined, prepareCliRequest: (request) => request }),
        run: async function* () {
          yield {
            kind: 'terminal',
            terminal: {
              content: 'conflict',
              durationMs: 0,
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
