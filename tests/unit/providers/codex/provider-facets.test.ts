import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_CODEX_ACCESS } from '../../../helpers/provider-credentials.js';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import {
  codexAppServerLifecycle,
  codexPreflight,
  codexRecoveryLifecycle,
  resetCodexPreflightCachesForTest,
} from '#src/providers/codex/provider-facets.js';
import { buildCodexContinuity } from '#src/providers/codex/request-mapping.js';
import { jsonValueSchema } from '#src/infra/json-value.js';
import { codexArtifactCapability, locateCodexRolloutArtifact } from '#src/providers/codex/artifacts.js';
import type { ArtifactCleanupRuntime, AppServerTransport, ProviderPreflightRuntime } from '#src/providers/contract.js';
import type { CodexProviderAccess } from '#src/providers/codex/execution-plan.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

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
  it('emits continuity the durable JSON boundary accepts', () => {
    // Production hands this mutation's continuity to `jsonValueSchema.parse` in
    // `providers/internal/bound-provider.ts`. JSON has no `undefined`, so a key that exists with an
    // undefined value is rejected there — and the throw lands inside recovery adoption, where it used
    // to terminalize the job. `toEqual` cannot see this: it ignores undefined-valued properties, which
    // is why every existing case here passed while the boundary rejected the same object.
    const continuity = buildCodexContinuity({ cwd: '/workspace', threadId: 'thread-1' });

    const mutation = codexRecoveryLifecycle.finalizeInterrupted(
      { resumable: true, updatedContinuity: continuity },
      continuity,
      {},
    );

    const emitted = 'providerContinuity' in mutation ? mutation.providerContinuity : undefined;
    expect(emitted).toBeDefined();
    expect(Object.keys(emitted as object)).toStrictEqual(['cwd', 'threadId']);
    expect(() => jsonValueSchema.parse(emitted)).not.toThrow();
  });

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
  it('accepts only the strict empty interrupt response', async () => {
    const continuity = { cwd: '/workspace', threadId: 'thread-1', turnId: 'turn-1' };
    const empty = vi.fn(async () => ({}));
    const echo = vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-1' }));

    await expect(codexAppServerLifecycle.interrupt?.(leaseWithRpc(empty), continuity)).resolves.toEqual({
      kind: 'accepted',
    });
    await expect(codexAppServerLifecycle.interrupt?.(leaseWithRpc(echo), continuity)).rejects.toThrow();
  });

  it('does not issue an interrupt without both exact continuity identifiers', async () => {
    const rpc = vi.fn(async () => ({}));

    await expect(
      codexAppServerLifecycle.interrupt?.(leaseWithRpc(rpc), { cwd: '/workspace', threadId: 'thread-1' }),
    ).resolves.toEqual({
      kind: 'not-accepted',
      reason: 'Codex continuity is missing the active thread or turn id.',
    });
    await expect(
      codexAppServerLifecycle.interrupt?.(leaseWithRpc(rpc), { cwd: '/workspace', turnId: 'turn-1' }),
    ).resolves.toEqual({
      kind: 'not-accepted',
      reason: 'Codex continuity is missing the active thread or turn id.',
    });

    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('codexAppServerLifecycle.probe', () => {
  it('rejects hostile effective config before the recovery thread/resume RPC', async () => {
    const continuity = { cwd: '/workspace/project', threadId: 'thread-1' };
    const rpc = vi.fn(async () => ({ thread: { id: 'thread-1' } }));

    await expect(
      codexAppServerLifecycle.probe?.(leaseWithRpc(rpc, { openai_base_url: 'https://proxy.invalid/v1' }), continuity, {
        request: { cwd: fixtureCanonicalWorkDir('/workspace/project') },
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
        request: { cwd: fixtureCanonicalWorkDir('/workspace/project') },
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
        request: { cwd: fixtureCanonicalWorkDir('/workspace/project') },
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
        request: { cwd: fixtureCanonicalWorkDir('/workspace/project') },
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

// `codexPreflight` had no tests. Both of its checks answered every failure with the remedy for the one cause
// they could name — "update the Codex CLI", "run codex login" — so a fork that lost to EAGAIN and an
// `auth.json` this process may not open were reported as an outdated CLI and an unauthenticated account. Both
// verdicts are also cached for a minute, so the wrong sentence is repeated without re-checking.
describe('codexPreflight', () => {
  const UPGRADE = /npm update -g @openai\/codex/u;
  const LOGIN = /Run "codex login"/u;
  const TOKENS = JSON.stringify({ tokens: { access_token: 'live-token' } });

  // The module-level caches outlive each test. Isolation is the explicit reset below, not the clock advance:
  // a test that forgot to preserve a 120s gap here used to fail on a sibling's cached verdict instead of its
  // own assertion, for a reason nothing in its own body explained.
  let clock = 1_700_000_000_000;
  beforeEach(() => {
    clock += 120_000;
    resetCodexPreflightCachesForTest();
  });

  function errno(code: string): Error {
    return Object.assign(new Error(code), { code });
  }

  function preflightRuntime(options: {
    appServer?: { status?: number | null; error?: Error };
    authFile?: string | Error;
    home?: string;
  }): ProviderPreflightRuntime<CodexProviderAccess> & { runExact: ReturnType<typeof vi.fn> } {
    const appServer = options.appServer ?? { status: 0 };
    const authFile = options.authFile ?? TOKENS;
    return {
      access: { home: options.home ?? TEST_CODEX_ACCESS.home },
      cwd: '/workspace/project',
      storage: {
        readFileSync: () => {
          if (authFile instanceof Error) throw authFile;
          return authFile;
        },
      },
      time: { now: () => clock },
      runExact: vi.fn(async () => ({
        stdout: '',
        stderr: '',
        status: appServer.status ?? null,
        ...(appServer.error === undefined ? {} : { error: appServer.error }),
      })),
    } as unknown as ProviderPreflightRuntime<CodexProviderAccess> & { runExact: ReturnType<typeof vi.fn> };
  }

  it('accepts a Codex CLI that answers and a home that holds tokens', async () => {
    await expect(codexPreflight(preflightRuntime({}))).resolves.toBeUndefined();
  });

  it.each([['EAGAIN'], ['ETIMEDOUT'], ['EMFILE']])(
    'does not blame the installed CLI when the probe failed on %s',
    async (code) => {
      const runtime = preflightRuntime({ appServer: { error: errno(code), status: null } });

      await expect(codexPreflight(runtime)).rejects.toThrow(/could not run/iu);
      await expect(
        codexPreflight(preflightRuntime({ appServer: { error: errno(code), status: null } })),
      ).rejects.not.toThrow(UPGRADE);
    },
  );

  it('does not blame the installed CLI when the probe was killed before it answered', async () => {
    await expect(codexPreflight(preflightRuntime({ appServer: { status: null } }))).rejects.toThrow(/killed/iu);
  });

  it.each([
    ['ENOENT', 'the binary is not installed'],
    ['EACCES', 'this process may not execute it'],
  ])('reports %s as an unusable CLI, because %s is a fact about this machine', async (code) => {
    await expect(codexPreflight(preflightRuntime({ appServer: { error: errno(code), status: null } }))).rejects.toThrow(
      UPGRADE,
    );
  });

  it('reports a CLI without the subcommand as one to update', async () => {
    await expect(codexPreflight(preflightRuntime({ appServer: { status: 1 } }))).rejects.toThrow(UPGRADE);
  });

  // The cache has no tenant key, so anything it holds decides for every later job. An answer may do that; an
  // unobserved cause may not — each job asks again and is refused, or not, on evidence of its own.
  it('never caches an undetermined verdict, so every preflight re-probes', async () => {
    const runtime = preflightRuntime({ appServer: { error: errno('EAGAIN'), status: null } });

    await expect(codexPreflight(runtime)).rejects.toThrow(/could not run/iu);
    await expect(codexPreflight(runtime)).rejects.toThrow(/could not run/iu);
    await expect(codexPreflight(runtime)).rejects.toThrow(/could not run/iu);

    expect(runtime.runExact, 'one fork that lost to EAGAIN must not answer for two later jobs').toHaveBeenCalledTimes(
      3,
    );
  });

  it('still caches an answered verdict for the TTL', async () => {
    const runtime = preflightRuntime({ appServer: { status: 1 } });

    await expect(codexPreflight(runtime)).rejects.toThrow(UPGRADE);
    await expect(codexPreflight(runtime)).rejects.toThrow(UPGRADE);

    expect(runtime.runExact, 'the CLI answered; asking again inside the minute repeats it').toHaveBeenCalledTimes(1);
  });

  /** Like `preflightRuntime`, but the auth read is countable — that is the observable for its own cache. */
  function countingAuthRuntime(authFile: string | Error, home: string) {
    let reads = 0;
    const runtime = preflightRuntime({ home });
    return {
      runtime: {
        ...runtime,
        storage: {
          readFileSync: () => {
            reads += 1;
            if (authFile instanceof Error) throw authFile;
            return authFile;
          },
        },
      } as unknown as typeof runtime,
      reads: () => reads,
    };
  }

  // The twin of the app-server rule two tests up, and it was fixed without being asserted: disabling this
  // guard let an unreadable `auth.json` be cached, so one EACCES answered for every later job on that home,
  // and the whole suite stayed green. Keyed by home, so the blast radius is narrower than the app-server
  // cache's — narrower is not absent.
  it('never caches an undetermined auth verdict, so every preflight re-reads', async () => {
    const { runtime, reads } = countingAuthRuntime(errno('EACCES'), `/home/user/.codex-uncached-${clock}`);

    await expect(codexPreflight(runtime)).rejects.toThrow(/could not read/iu);
    await expect(codexPreflight(runtime)).rejects.toThrow(/could not read/iu);
    await expect(codexPreflight(runtime)).rejects.toThrow(/could not read/iu);

    expect(reads(), 'one unreadable file must not answer for two later jobs').toBe(3);
  });

  it('still caches an answered auth verdict for the TTL', async () => {
    const { runtime, reads } = countingAuthRuntime(JSON.stringify({ tokens: {} }), `/home/user/.codex-cached-${clock}`);

    await expect(codexPreflight(runtime)).rejects.toThrow(LOGIN);
    await expect(codexPreflight(runtime)).rejects.toThrow(LOGIN);

    expect(reads(), 'the file answered; asking again inside the minute repeats it').toBe(1);
  });

  it('reports an absent auth.json as an unauthenticated account', async () => {
    const runtime = preflightRuntime({ authFile: errno('ENOENT'), home: `/home/user/.codex-a-${clock}` });

    await expect(codexPreflight(runtime)).rejects.toThrow(LOGIN);
  });

  it('reports a corrupt auth.json as unauthenticated, because logging in rewrites it', async () => {
    const runtime = preflightRuntime({ authFile: '{not json', home: `/home/user/.codex-b-${clock}` });

    await expect(codexPreflight(runtime)).rejects.toThrow(LOGIN);
  });

  it('does not tell an operator to log in when auth.json could not be read at all', async () => {
    // `codex login` writes this file; it does not grant the daemon permission to read it afterwards, so the
    // remedy does not apply and must not be offered.
    const runtime = preflightRuntime({ authFile: errno('EACCES'), home: `/home/user/.codex-c-${clock}` });

    await expect(codexPreflight(runtime)).rejects.toThrow(/could not read/iu);
    await expect(
      codexPreflight(preflightRuntime({ authFile: errno('EACCES'), home: `/home/user/.codex-d-${clock}` })),
    ).rejects.not.toThrow(LOGIN);
  });

  // Both branches of the unreadable case have to leave the operator with something to do. Naming what was not
  // established and stopping there is half a refusal — it closes the wrong door without opening one — and the
  // deferred half (teaching the job to ask again instead of dying) is `docs/todo/preflight-cannot-defer.md`,
  // so until then the retry is the operator's and has to be said.
  it.each([
    ['EACCES', /readable by the user running the Coral daemon/u],
    ['EPERM', /readable by the user running the Coral daemon/u],
    ['EIO', /Retry the command/u],
  ])('names an action for an auth.json it could not read (%s)', async (code, remedy) => {
    const runtime = preflightRuntime({ authFile: errno(code), home: `/home/user/.codex-remedy-${code}-${clock}` });

    await expect(codexPreflight(runtime)).rejects.toThrow(remedy);
  });

  it('names the error as unknown when an auth.json read failure carries no code', async () => {
    const runtime = preflightRuntime({
      authFile: new Error('boom'),
      home: `/home/user/.codex-remedy-codeless-${clock}`,
    });

    await expect(codexPreflight(runtime)).rejects.toThrow(/\(unknown error\)/u);
    await expect(codexPreflight(runtime)).rejects.toThrow(/Retry the command/u);
  });

  it('reports a readable auth.json without tokens as unauthenticated', async () => {
    const runtime = preflightRuntime({
      authFile: JSON.stringify({ tokens: {} }),
      home: `/home/user/.codex-e-${clock}`,
    });

    await expect(codexPreflight(runtime)).rejects.toThrow(LOGIN);
  });
});
