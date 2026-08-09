import { describe, expect, it, vi } from 'vitest';
import { TEST_CODEX_ACCESS } from '../../../helpers/provider-credentials.js';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import { codexAppServerLifecycle, codexRecoveryLifecycle } from '#src/providers/codex/provider-facets.js';
import { buildCodexContinuity } from '#src/providers/codex/request-mapping.js';
import { codexArtifactCapability, locateCodexRolloutArtifact } from '#src/providers/codex/artifacts.js';
import type { ArtifactCleanupRuntime, AppServerTransport } from '#src/providers/contract.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

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
): AppServerTransport {
  return {
    rpc: ((method: string, params: Record<string, unknown>) =>
      method === 'config/read'
        ? Promise.resolve({ config: effectiveConfig })
        : (rpc as unknown as (method: string, params: Record<string, unknown>) => Promise<unknown>)(
            method,
            params,
          )) as AppServerTransport['rpc'],
    subscribe: () => () => {},
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

describe('codexAppServerLifecycle.interrupt', () => {
  it('confirms interruption only when the response echoes the exact thread and turn', async () => {
    const continuity = { cwd: '/workspace', threadId: 'thread-1', turnId: 'turn-1' };
    const mismatch = vi.fn(async () => ({ threadId: 'thread-other', turnId: 'turn-1' }));
    const exact = vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-1' }));

    await expect(codexAppServerLifecycle.interrupt?.(leaseWithRpc(mismatch), continuity)).resolves.toBe(false);
    await expect(codexAppServerLifecycle.interrupt?.(leaseWithRpc(exact), continuity)).resolves.toBe(true);
  });

  it('does not issue an interrupt without both exact continuity identifiers', async () => {
    const rpc = vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-1' }));

    await expect(
      codexAppServerLifecycle.interrupt?.(leaseWithRpc(rpc), { cwd: '/workspace', threadId: 'thread-1' }),
    ).resolves.toBe(false);
    await expect(
      codexAppServerLifecycle.interrupt?.(leaseWithRpc(rpc), { cwd: '/workspace', turnId: 'turn-1' }),
    ).resolves.toBe(false);

    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('codexAppServerLifecycle.probe', () => {
  it('rejects hostile effective config before the recovery thread/resume RPC', async () => {
    const continuity = { cwd: '/workspace/project', threadId: 'thread-1' };
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-1' } }));

    await expect(
      codexAppServerLifecycle.probe?.(leaseWithRpc(rpc, { openai_base_url: 'https://proxy.invalid/v1' }), continuity, {
        request: { cwd: '/workspace/project' },
      }),
    ).rejects.toThrow("Unsupported Codex effective setting 'openai_base_url'");
    expect(rpc).not.toHaveBeenCalled();
  });

  it('resumes with an in-scope continuity cwd and drops transient turn ids from the update', async () => {
    const continuity = {
      cwd: '/workspace/project/subdir',
      threadId: 'thread-1',
      turnId: 'turn-1',
    };
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-1' } }));

    await expect(
      codexAppServerLifecycle.probe?.(leaseWithRpc(rpc), continuity, {
        request: { cwd: '/workspace/project' },
      }),
    ).resolves.toEqual({
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
      config: {
        shell_environment_policy: {
          inherit: 'all',
          set: { CORAL_CHILD: '1' },
        },
      },
    });
  });

  it('rejects a valid-shaped thread/resume response for a different thread', async () => {
    const continuity = { cwd: '/workspace/project', threadId: 'thread-1' };
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-other' } }));

    await expect(
      codexAppServerLifecycle.probe?.(leaseWithRpc(rpc), continuity, {
        request: { cwd: '/workspace/project' },
      }),
    ).rejects.toThrow('Codex recovery probe did not resume the exact requested thread id.');
  });

  it('does not resume when continuity cwd is outside the scoped project cwd', async () => {
    const continuity = {
      cwd: '/tmp/attacker',
      threadId: 'thread-1',
      turnId: 'turn-1',
    };
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-1' } }));

    await expect(
      codexAppServerLifecycle.probe?.(leaseWithRpc(rpc), continuity, {
        request: { cwd: '/workspace/project' },
      }),
    ).resolves.toEqual({
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
  it('reconciles response loss without replaying the visible external effect', async () => {
    const runtime = new SimulationRuntime();
    const handle = '/tmp/codex-response-loss.jsonl';
    runtime.storage.mkdirSync('/tmp', { recursive: true });
    runtime.storage.writeFileSync(handle, '{}\n', { encoding: 'utf-8' });
    const unlink = vi.spyOn(runtime.storage, 'unlinkSync');
    const writeAtomicSync = runtime.storage.writeAtomicSync.bind(runtime.storage);
    let actionWrites = 0;
    vi.spyOn(runtime.storage, 'writeAtomicSync').mockImplementation((...args) => {
      if (args[0].includes('.provider-artifact-discard') && ++actionWrites === 2) return false;
      return writeAtomicSync(...args);
    });
    const cleanupRuntime: ArtifactCleanupRuntime = {
      storage: runtime.storage,
      env: runtime.env,
      paths: runtime.paths,
      time: { sleep: async () => {} } as unknown as ArtifactCleanupRuntime['time'],
    };
    const action = {
      handles: [handle],
      actionId: 'codex-response-loss-action',
      payloadHash: 'codex-response-loss-payload',
      access: TEST_CODEX_ACCESS,
      runtime: cleanupRuntime,
    };

    await expect(codexArtifactCapability.discardArtifacts(action)).rejects.toThrow(
      'Failed to persist provider artifact action',
    );
    const reconciled = await codexArtifactCapability.reconcileDiscard(action);
    expect(reconciled).toEqual({ kind: 'applied', outcome: { kind: 'discarded' } });
    if (reconciled.kind !== 'applied') await codexArtifactCapability.discardArtifacts(action);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('discards only the recorded handles it is given', async () => {
    const simulation = new SimulationRuntime();
    const unlinkSync = vi.spyOn(simulation.storage, 'unlinkSync');
    const runtime: ArtifactCleanupRuntime = {
      storage: simulation.storage,
      env: simulation.env,
      paths: simulation.paths,
      time: { sleep: async () => {} } as unknown as ArtifactCleanupRuntime['time'],
    };

    await expect(
      codexArtifactCapability.discardArtifacts({
        handles: ['/tmp/one.jsonl', '/tmp/two.jsonl'],
        actionId: 'test-action',
        payloadHash: 'test-payload',
        access: TEST_CODEX_ACCESS,
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
      codexArtifactCapability.locateArtifact?.({ conversationRef: 'thread-1', access: TEST_CODEX_ACCESS, runtime }),
    ).toBe(`${day}/rollout-2026-05-04T00-00-00-thread-1.jsonl`);
    expect(
      codexArtifactCapability.locateArtifact?.({
        conversationRef: 'missing-thread',
        access: TEST_CODEX_ACCESS,
        runtime,
      }),
    ).toBeNull();
  });
});
