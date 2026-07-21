import { describe, expect, it, vi } from 'vitest';
import { TEST_CODEX_SOURCE } from '../../../helpers/provider-credentials.js';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { codexRecoveryLifecycle } from '#src/providers/codex/provider-facets.js';
import { buildCodexContinuity, buildCodexProviderServerSpec } from '#src/providers/codex/request-mapping.js';
import { codexArtifactCapability, locateCodexRolloutArtifact } from '#src/providers/codex/artifacts.js';
import type { ArtifactCleanupRuntime, ProviderServerLease } from '#src/providers/contract.js';

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

function leaseWithRpc(
  rpc: ReturnType<typeof vi.fn>,
  effectiveConfig: Record<string, unknown> = {},
): ProviderServerLease {
  return {
    rpc: ((method: string, params: Record<string, unknown>) =>
      method === 'config/read'
        ? Promise.resolve({ config: effectiveConfig })
        : (rpc as unknown as (method: string, params: Record<string, unknown>) => Promise<unknown>)(
            method,
            params,
          )) as ProviderServerLease['rpc'],
    subscribe: () => () => {},
    release: () => {},
    closed: Promise.resolve(),
  };
}

describe('codexRecoveryLifecycle.finalizeInterrupted', () => {
  it('uses the preserved conversation ref when the session is resumable without a parsed thread id', () => {
    const continuity = buildCodexContinuity({
      cwd: '/workspace',
    });
    const mutation = codexRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: continuity,
      },
      continuity,
      { preservedConversationRef: 'ref-x' },
    );

    expect(mutation).toEqual({
      kind: 'set_resumable',
      conversationRef: 'ref-x',
      providerContinuity: {
        cwd: '/workspace',
      },
    });
  });

  it('preserves continuity when the session is resumable but there is no effective conversation ref to write', () => {
    const continuity = buildCodexContinuity({
      cwd: '/workspace',
    });
    const mutation = codexRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: continuity,
      },
      continuity,
      {},
    );

    expect(mutation).toEqual({
      kind: 'preserve',
      providerContinuity: {
        cwd: '/workspace',
      },
    });
  });
});

describe('codexRecoveryLifecycle.probe', () => {
  it('rejects hostile effective config before the recovery thread/resume RPC', async () => {
    const continuity = { cwd: '/workspace/project', threadId: 'thread-1' };
    buildCodexProviderServerSpec({ cwd: '/workspace/project', coralEnv: {} }, continuity);
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-1' } }));

    await expect(
      codexRecoveryLifecycle.probe(leaseWithRpc(rpc, { openai_base_url: 'https://proxy.invalid/v1' }), continuity),
    ).rejects.toThrow("Unsupported Codex effective setting 'openai_base_url'");
    expect(rpc).not.toHaveBeenCalled();
  });

  it('resumes with an in-scope continuity cwd and drops transient turn ids from the update', async () => {
    const continuity = {
      cwd: '/workspace/project/subdir',
      threadId: 'thread-1',
      turnId: 'turn-1',
      attacker: 'drop-me',
    };
    buildCodexProviderServerSpec({ cwd: '/workspace/project', coralEnv: {} }, continuity);
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-1' } }));

    await expect(codexRecoveryLifecycle.probe(leaseWithRpc(rpc), continuity)).resolves.toEqual({
      resumable: true,
      updatedContinuity: {
        cwd: '/workspace/project/subdir',
        threadId: 'thread-1',
      },
    });
    expect(rpc).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-1',
      cwd: '/workspace/project/subdir',
      model: null,
      modelProvider: 'openai',
      approvalPolicy: 'never',
    });
  });

  it('does not resume when continuity cwd is outside the scoped project cwd', async () => {
    const continuity = {
      cwd: '/tmp/attacker',
      threadId: 'thread-1',
      turnId: 'turn-1',
    };
    buildCodexProviderServerSpec({ cwd: '/workspace/project', coralEnv: {} }, continuity);
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-1' } }));

    await expect(codexRecoveryLifecycle.probe(leaseWithRpc(rpc), continuity)).resolves.toEqual({
      resumable: false,
      updatedContinuity: {
        threadId: 'thread-1',
      },
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('locateCodexRolloutArtifact', () => {
  const root = '/home/user/.codex/sessions';
  const day = `${root}/2026/05/04`;

  it('returns no_match when no rollout JSONL matches the known thread id', () => {
    const storage = storageForTree({
      [root]: [dirent('2026', 'dir')],
      [`${root}/2026`]: [dirent('05', 'dir')],
      [`${root}/2026/05`]: [dirent('04', 'dir')],
      [day]: [dirent('rollout-aaa-other-thread.jsonl', 'file')],
    });

    expect(locateCodexRolloutArtifact({ threadId: 'thread-1', sessionsRoot: root, storage })).toMatchObject({
      kind: 'no_match',
      diagnostic: expect.stringContaining('thread-1'),
    });
  });

  it('returns the concrete rollout JSONL path for a single matching thread id', () => {
    const storage = storageForTree({
      [root]: [dirent('2026', 'dir')],
      [`${root}/2026`]: [dirent('05', 'dir')],
      [`${root}/2026/05`]: [dirent('04', 'dir')],
      [day]: [dirent('rollout-2026-05-04T00-00-00-thread-1.jsonl', 'file')],
    });

    expect(locateCodexRolloutArtifact({ threadId: 'thread-1', sessionsRoot: root, storage })).toEqual({
      kind: 'match',
      artifact: {
        handle: `${day}/rollout-2026-05-04T00-00-00-thread-1.jsonl`,
        identity: { kind: 'codex-rollout', threadId: 'thread-1' },
      },
    });
  });

  it('returns ambiguous when multiple rollout JSONL files match the known thread id', () => {
    const storage = storageForTree({
      [root]: [dirent('2026', 'dir')],
      [`${root}/2026`]: [dirent('05', 'dir')],
      [`${root}/2026/05`]: [dirent('04', 'dir')],
      [day]: [dirent('rollout-a-thread-1.jsonl', 'file'), dirent('rollout-b-thread-1.jsonl', 'file')],
    });

    expect(locateCodexRolloutArtifact({ threadId: 'thread-1', sessionsRoot: root, storage })).toMatchObject({
      kind: 'ambiguous',
      diagnostic: expect.stringContaining('2 rollout JSONL'),
      matches: [`${day}/rollout-a-thread-1.jsonl`, `${day}/rollout-b-thread-1.jsonl`],
    });
  });
});

describe('codexArtifactCapability', () => {
  it('discards only the recorded handles it is given', async () => {
    const unlinkSync = vi.fn();
    const runtime = {
      storage: { unlinkSync, existsSync: () => false },
      env: { homedir: () => '/home/user' },
      time: { sleep: async () => {} },
    } as unknown as ArtifactCleanupRuntime;

    await expect(
      codexArtifactCapability.discardArtifacts({
        handles: ['/tmp/one.jsonl', '/tmp/two.jsonl'],
        source: TEST_CODEX_SOURCE,
        runtime,
      }),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync.mock.calls).toEqual([['/tmp/one.jsonl'], ['/tmp/two.jsonl']]);
  });

  it('locateArtifact resolves the rollout handle for a known thread id from the runtime', () => {
    const root = '/home/user/.codex/sessions';
    const day = `${root}/2026/05/04`;
    const runtime = {
      storage: storageForTree({
        [root]: [dirent('2026', 'dir')],
        [`${root}/2026`]: [dirent('05', 'dir')],
        [`${root}/2026/05`]: [dirent('04', 'dir')],
        [day]: [dirent('rollout-2026-05-04T00-00-00-thread-1.jsonl', 'file')],
      }),
      env: { homedir: () => '/home/user', get: () => undefined },
    } as unknown as ArtifactCleanupRuntime;

    expect(
      codexArtifactCapability.locateArtifact?.({ conversationRef: 'thread-1', source: TEST_CODEX_SOURCE, runtime }),
    ).toBe(`${day}/rollout-2026-05-04T00-00-00-thread-1.jsonl`);
    expect(
      codexArtifactCapability.locateArtifact?.({
        conversationRef: 'missing-thread',
        source: TEST_CODEX_SOURCE,
        runtime,
      }),
    ).toBeNull();
  });
});
