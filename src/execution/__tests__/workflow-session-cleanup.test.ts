import { describe, expect, it, vi } from 'vitest';
import type { ArtifactCleanupRuntime, Provider } from '../../providers/types.js';
import type { WorkflowSessionHandle } from '../../workflow/types.js';
import { dispatchWorkflowSessionCleanup, type WorkflowSessionCleanupDeps } from '../service.js';

const noopCleanupRuntime = {} as ArtifactCleanupRuntime;

function makeDeps(overrides: Partial<WorkflowSessionCleanupDeps>): WorkflowSessionCleanupDeps {
  return {
    resolveConversationRef: vi.fn(() => undefined),
    getProvider: vi.fn(() => undefined),
    cleanupRuntime: noopCleanupRuntime,
    onError: vi.fn(),
    ...overrides,
  };
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'claude',
    execute: vi.fn(async () => ({ content: 'ok' })),
    ...overrides,
  };
}

describe('dispatchWorkflowSessionCleanup', () => {
  it('is a no-op for an empty session list', () => {
    const deps = makeDeps({});
    dispatchWorkflowSessionCleanup([], deps);
    expect(deps.resolveConversationRef).not.toHaveBeenCalled();
    expect(deps.getProvider).not.toHaveBeenCalled();
  });

  it('groups conversation refs by provider and invokes each provider cleanup once', async () => {
    const cleanupClaude = vi.fn(async () => {});
    const cleanupCodex = vi.fn(async () => {});
    const providers = new Map<string, Provider>([
      ['claude', makeProvider({ name: 'claude', cleanupSessions: cleanupClaude })],
      ['codex', makeProvider({ name: 'codex', cleanupSessions: cleanupCodex })],
    ]);

    const deps = makeDeps({
      resolveConversationRef: vi.fn((_provider, sessionId) => `ref-${sessionId}`),
      getProvider: vi.fn((name) => providers.get(name)),
    });

    const sessions: WorkflowSessionHandle[] = [
      { providerName: 'claude', sessionId: 'sess-a' },
      { providerName: 'claude', sessionId: 'sess-b' },
      { providerName: 'codex', sessionId: 'sess-c' },
    ];

    dispatchWorkflowSessionCleanup(sessions, deps);
    await Promise.resolve();

    expect(cleanupClaude).toHaveBeenCalledTimes(1);
    expect(cleanupClaude).toHaveBeenCalledWith(noopCleanupRuntime, ['ref-sess-a', 'ref-sess-b']);
    expect(cleanupCodex).toHaveBeenCalledTimes(1);
    expect(cleanupCodex).toHaveBeenCalledWith(noopCleanupRuntime, ['ref-sess-c']);
  });

  it('skips sessions whose conversation ref is unresolved', async () => {
    const cleanupClaude = vi.fn(async () => {});
    const deps = makeDeps({
      resolveConversationRef: vi.fn((_provider, sessionId) => (sessionId === 'known' ? 'ref-known' : undefined)),
      getProvider: vi.fn(() => makeProvider({ cleanupSessions: cleanupClaude })),
    });

    dispatchWorkflowSessionCleanup(
      [
        { providerName: 'claude', sessionId: 'known' },
        { providerName: 'claude', sessionId: 'unknown' },
      ],
      deps,
    );
    await Promise.resolve();

    expect(cleanupClaude).toHaveBeenCalledWith(noopCleanupRuntime, ['ref-known']);
  });

  it('skips providers without a cleanupSessions implementation', async () => {
    const deps = makeDeps({
      resolveConversationRef: vi.fn(() => 'ref-1'),
      getProvider: vi.fn(() => makeProvider({ cleanupSessions: undefined })),
    });

    expect(() =>
      dispatchWorkflowSessionCleanup([{ providerName: 'codex', sessionId: 'sess-1' }], deps),
    ).not.toThrow();
    await Promise.resolve();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('surfaces a warning when a provider cleanup rejects', async () => {
    const failure = new Error('disk full');
    const cleanupClaude = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();

    dispatchWorkflowSessionCleanup(
      [{ providerName: 'claude', sessionId: 'sess-1' }],
      makeDeps({
        resolveConversationRef: vi.fn(() => 'ref-1'),
        getProvider: vi.fn(() => makeProvider({ cleanupSessions: cleanupClaude })),
        onError,
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(cleanupClaude).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('Provider claude session cleanup failed: disk full');
  });

  it('deduplicates identical conversation refs dispatched to one provider', async () => {
    const cleanupClaude = vi.fn(async () => {});
    const deps = makeDeps({
      resolveConversationRef: vi.fn(() => 'ref-shared'),
      getProvider: vi.fn(() => makeProvider({ cleanupSessions: cleanupClaude })),
    });

    dispatchWorkflowSessionCleanup(
      [
        { providerName: 'claude', sessionId: 'sess-a' },
        { providerName: 'claude', sessionId: 'sess-b' },
      ],
      deps,
    );
    await Promise.resolve();

    expect(cleanupClaude).toHaveBeenCalledWith(noopCleanupRuntime, ['ref-shared']);
  });
});
