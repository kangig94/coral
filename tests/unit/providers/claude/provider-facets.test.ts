import { describe, expect, it, vi } from 'vitest';
import { TEST_CLAUDE_ACCESS } from '../../../helpers/provider-credentials.js';

import type { DirentLike, StoragePort } from '#src/infra/port-types.js';
import {
  claudeAppServerLifecycle,
  claudePreflight,
  claudeRecoveryLifecycle,
} from '#src/providers/claude/provider-facets.js';
import {
  claudeArtifactCapability,
  deleteClaudeJsonlArtifactsForConversation,
  locateClaudeJsonlArtifact,
} from '#src/providers/claude/artifacts.js';
import type { AppServerTransport, ArtifactCleanupRuntime, ProviderPreflightRuntime } from '#src/providers/contract.js';
import type { ClaudeProviderAccess } from '#src/providers/claude/execution-plan.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function claudePreflightRuntime(
  files: Readonly<Record<string, string>>,
): ProviderPreflightRuntime<ClaudeProviderAccess> {
  const runExact = vi.fn(async (_command: string, args: string[]) =>
    args[0] === '--version'
      ? { stdout: 'claude 1.0.0', stderr: '', status: 0 }
      : {
          stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'team' }),
          stderr: '',
          status: 0,
        },
  );
  return {
    access: TEST_CLAUDE_ACCESS,
    cwd: '/workspace/project',
    storage: {
      existsSync: (path: string) => Object.hasOwn(files, path),
      readFileSync: (path: string) => files[path] ?? '',
    },
    runExact,
  } as unknown as ProviderPreflightRuntime<ClaudeProviderAccess>;
}

/** A preflight runtime whose `claude --version` never produces an answer. */
function unanswerableVersionProbeRuntime(code: string): ProviderPreflightRuntime<ClaudeProviderAccess> {
  return {
    access: TEST_CLAUDE_ACCESS,
    cwd: '/workspace/project',
    storage: { existsSync: () => false, readFileSync: () => '' },
    runExact: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error(code), { code }),
    })),
  } as unknown as ProviderPreflightRuntime<ClaudeProviderAccess>;
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
  // Preflight refuses either way, and the two refusals must not read alike. Telling an operator whose machine
  // ran out of process slots to install the Claude CLI sends them to fix something that was never broken.
  it('does not report an unanswerable version probe as a missing CLI', async () => {
    // The two refusals must not read alike, and the "unknown" one must not repeat the inner sentence's own
    // opening — it composed to "could not be determined: could not run ...".
    await expect(claudePreflight(unanswerableVersionProbeRuntime('EAGAIN'))).rejects.toThrow(
      /availability is unknown/iu,
    );
    await expect(claudePreflight(unanswerableVersionProbeRuntime('EAGAIN'))).rejects.toThrow(/retry the command/iu);
  });

  it('still reports a genuinely missing CLI as missing', async () => {
    await expect(claudePreflight(unanswerableVersionProbeRuntime('ENOENT'))).rejects.toThrow(
      /Claude CLI not available/iu,
    );
  });

  it.each([
    {
      layer: 'selected-profile',
      settingsPath: '/home/user/.claude/settings.json',
      contents: '{invalid',
      problem: 'contain invalid JSON',
    },
    {
      layer: 'project',
      settingsPath: '/workspace/project/.claude/settings.json',
      contents: '[]',
      problem: 'are not a JSON object',
    },
  ])('identifies the $layer settings layer and gives path-safe recovery for malformed JSON', async (fixture) => {
    const runtime = claudePreflightRuntime({ [fixture.settingsPath]: fixture.contents });

    const failure = await claudePreflight(runtime).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(`the ${fixture.layer} settings ${fixture.problem}`);
    expect(message).toContain('Repair or remove that settings file, then retry.');
    expect(message).toContain('docs/configuration.md#multi-account-provider-routing');
    expect(message).not.toContain(fixture.settingsPath);
    expect(runtime.runExact).not.toHaveBeenCalled();
  });

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
      "Unsupported Claude credential selector 'CLAUDE_CODE_USE_BEDROCK'",
    );
    expect(runtime.runExact).not.toHaveBeenCalled();
  });

  it('rejects case-variant external-provider selectors', async () => {
    const settingsPath = '/workspace/project/.claude/settings.json';
    const runtime = claudePreflightRuntime({
      [settingsPath]: JSON.stringify({ env: { claude_code_use_bedrock: '1' } }),
    });

    await expect(claudePreflight(runtime)).rejects.toThrow(
      "Unsupported Claude credential selector 'claude_code_use_bedrock'",
    );
    expect(runtime.runExact).not.toHaveBeenCalled();
  });

  it.each(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'])(
    'rejects the %s credential helper from the selected access',
    async (helper) => {
      const settingsPath = '/home/user/.claude/settings.json';
      const runtime = claudePreflightRuntime({ [settingsPath]: JSON.stringify({ [helper]: '/usr/bin/helper' }) });

      await expect(claudePreflight(runtime)).rejects.toThrow(`Unsupported Claude credential helper '${helper}'`);
      expect(runtime.runExact).not.toHaveBeenCalled();
    },
  );

  it('accepts a subscription-authenticated profile without API-key evidence', async () => {
    const runtime = claudePreflightRuntime({
      '/home/user/.claude/settings.json': JSON.stringify({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' } }),
    });

    await expect(claudePreflight(runtime)).resolves.toBeUndefined();
    expect(vi.mocked(runtime.runExact).mock.calls).toEqual([
      ['claude', ['--version'], { timeout: 10_000, encoding: 'utf-8' }],
      ['claude', ['auth', 'status', '--json'], { timeout: 5_000, encoding: 'utf-8' }],
    ]);
  });

  it('surfaces the detector authentication recovery message without a redundant prefix', async () => {
    const runtime = claudePreflightRuntime({});
    runtime.runExact = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'claude 1.0.0', stderr: '', status: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ loggedIn: false }),
        stderr: '',
        status: 0,
      });

    await expect(claudePreflight(runtime)).rejects.toThrow(
      'Claude CLI is not authenticated. Run "claude auth login" with the same CLAUDE_CONFIG_DIR, then retry.',
    );
  });

  it.each([
    ['conflicting recognized evidence', { loggedIn: true, status: 'unauthenticated' }],
    ['an unknown schema containing an auth-error token', { futureAuthState: 'unauthenticated' }],
  ])('retains compatibility when Claude returns %s', async (_label, authOutput) => {
    const runtime = claudePreflightRuntime({});
    runtime.runExact = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'claude 1.0.0', stderr: '', status: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify(authOutput),
        stderr: '',
        status: 0,
      });

    await expect(claudePreflight(runtime)).resolves.toBeUndefined();
  });
});

describe('claudeRecoveryLifecycle.finalizeInterrupted', () => {
  it('uses the preserved conversation ref when the session is resumable without a bootstrap signature', () => {
    const mutation = claudeRecoveryLifecycle.finalizeInterrupted(
      {
        resumable: true,
        updatedContinuity: {
          brokerSessionKey: 'broker-1',
          brokerTurnId: 'turn-1',
        },
      },
      {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
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
          brokerTurnId: 'turn-1',
        },
      },
      {
        brokerSessionKey: 'broker-1',
        brokerTurnId: 'turn-1',
      },
      {},
    );

    expect(mutation).toEqual({
      kind: 'preserve',
    });
  });
});

describe('claudeAppServerLifecycle.interrupt', () => {
  function transportWithRpc(rpc: ReturnType<typeof vi.fn>): AppServerTransport {
    return {
      rpc: rpc as AppServerTransport['rpc'],
      subscribe: () => () => {},
      closed: Promise.resolve(),
    };
  }

  it('accepts an interrupt request only for a positive acknowledgement of the exact broker turn', async () => {
    const continuity = { brokerSessionKey: 'session-1', brokerTurnId: 'turn-1' };
    const mismatch = vi.fn(async () => ({ interrupted: true, brokerTurnId: 'turn-other' }));
    const negative = vi.fn(async () => ({ interrupted: false, brokerTurnId: 'turn-1' }));
    const exact = vi.fn(async () => ({ interrupted: true, brokerTurnId: 'turn-1' }));

    await expect(claudeAppServerLifecycle.interrupt?.(transportWithRpc(mismatch), continuity)).resolves.toMatchObject({
      kind: 'not-accepted',
    });
    await expect(claudeAppServerLifecycle.interrupt?.(transportWithRpc(negative), continuity)).resolves.toMatchObject({
      kind: 'not-accepted',
    });
    await expect(claudeAppServerLifecycle.interrupt?.(transportWithRpc(exact), continuity)).resolves.toEqual({
      kind: 'accepted',
    });
  });

  it('rejects incomplete continuity without issuing an interrupt', async () => {
    const rpc = vi.fn(async () => ({ interrupted: true, brokerTurnId: 'turn-1' }));
    const transport = transportWithRpc(rpc);

    await expect(claudeAppServerLifecycle.interrupt?.(transport, { brokerSessionKey: 'session-1' })).rejects.toThrow(
      'Invalid persisted Claude continuity.',
    );
    await expect(claudeAppServerLifecycle.interrupt?.(transport, { brokerTurnId: 'turn-1' })).rejects.toThrow(
      'Invalid persisted Claude continuity.',
    );

    expect(rpc).not.toHaveBeenCalled();
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
  it('reconciles response loss without replaying the visible external effect', async () => {
    const runtime = new SimulationRuntime();
    const handle = '/tmp/claude-response-loss.jsonl';
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
      actionId: 'claude-response-loss-action',
      payloadHash: 'claude-response-loss-payload',
      access: TEST_CLAUDE_ACCESS,
      runtime: cleanupRuntime,
    };

    await expect(claudeArtifactCapability.discardArtifacts(action)).rejects.toThrow(
      'Failed to persist provider artifact action',
    );
    const reconciled = await claudeArtifactCapability.reconcileDiscard(action);
    expect(reconciled).toEqual({ kind: 'applied', outcome: { kind: 'discarded' } });
    if (reconciled.kind !== 'applied') await claudeArtifactCapability.discardArtifacts(action);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('locateArtifact resolves the project JSONL handle for a known conversationRef from the runtime', () => {
    const root = '/home/user/.claude/projects';
    const runtime = {
      storage: storageForTree({
        [root]: [dirent('-workspace-a', 'dir')],
        [`${root}/-workspace-a`]: [dirent('session-1.jsonl', 'file')],
      }),
      env: { homedir: () => '/home/user' },
    } as unknown as ArtifactCleanupRuntime;

    expect(
      claudeArtifactCapability.locateArtifact?.({ conversationRef: 'session-1', access: TEST_CLAUDE_ACCESS, runtime }),
    ).toBe(`${root}/-workspace-a/session-1.jsonl`);
    expect(
      claudeArtifactCapability.locateArtifact?.({
        conversationRef: 'missing-session',
        access: TEST_CLAUDE_ACCESS,
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
      env: { homedir: () => '/home/user' },
    } as unknown as ArtifactCleanupRuntime;

    expect(
      claudeArtifactCapability.locateArtifact?.({ conversationRef: 'session-1', access: TEST_CLAUDE_ACCESS, runtime }),
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
    const simulation = new SimulationRuntime();
    const unlinkSync = vi.spyOn(simulation.storage, 'unlinkSync');
    const runtime: ArtifactCleanupRuntime = {
      storage: simulation.storage,
      env: simulation.env,
      paths: simulation.paths,
      time: { sleep: async () => {} } as unknown as ArtifactCleanupRuntime['time'],
    };

    await expect(
      claudeArtifactCapability.discardArtifacts({
        handles: ['/tmp/session-a.jsonl', '/tmp/session-b.jsonl'],
        actionId: 'test-action',
        payloadHash: 'test-payload',
        access: TEST_CLAUDE_ACCESS,
        runtime,
      }),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync.mock.calls).toEqual([['/tmp/session-a.jsonl'], ['/tmp/session-b.jsonl']]);
  });
});
