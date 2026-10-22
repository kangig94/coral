import { describe, expect, it, vi } from 'vitest';
import { TEST_CLAUDE_ACCESS } from '#tests/helpers/provider-credentials.js';
import { claudeAppServerLifecycle, claudePreflight } from '#src/providers/claude/provider-facets.js';
import { claudeArtifactCapability } from '#src/providers/claude/artifacts.js';
import type { AppServerTransport, ArtifactCleanupRuntime, ProviderPreflightRuntime } from '#src/providers/contract.js';
import type { ClaudeProviderAccess } from '#src/providers/claude/execution-plan.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { ProviderRpcError } from '#src/providers/app-server-transport.js';

function claudePreflightRuntime(
  files: Readonly<Record<string, string | Error>>,
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
      readFileSync: (path: string) => {
        const contents = files[path];
        if (contents instanceof Error) throw contents;
        if (contents === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return contents;
      },
    },
    runExact,
  } as unknown as ProviderPreflightRuntime<ClaudeProviderAccess>;
}

/** A preflight runtime whose `claude --version` never produces an answer. */
function unanswerableVersionProbeRuntime(code: string): ProviderPreflightRuntime<ClaudeProviderAccess> {
  return {
    access: TEST_CLAUDE_ACCESS,
    cwd: '/workspace/project',
    storage: {
      existsSync: () => false,
      readFileSync: () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      statSync: () => ({ isDirectory: () => true }),
      observeDirectoryTraversabilitySync: () => 'traversable',
    },
    runExact: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error(code), { code }),
    })),
  } as unknown as ProviderPreflightRuntime<ClaudeProviderAccess>;
}

describe('claudePreflight', () => {
  it('does not report an unanswerable version probe as a missing CLI', async () => {
    const outcome = await claudePreflight(unanswerableVersionProbeRuntime('EAGAIN'));

    expect(outcome).toEqual({ kind: 'undetermined', message: expect.stringMatching(/availability is unknown/iu) });
    if (outcome.kind !== 'undetermined') throw new Error('expected undetermined');
    expect(outcome.message).toMatch(/retry the command/iu);
  });

  it('still reports a genuinely missing CLI as missing', async () => {
    await expect(claudePreflight(unanswerableVersionProbeRuntime('ENOENT'))).resolves.toEqual({
      kind: 'refused',
      message: expect.stringMatching(/Claude CLI not available/iu),
    });
  });

  it.each([['account settings', '/home/user/.claude/settings.json']])(
    'rejects external-provider selectors from %s before probing Claude',
    async (_label, settingsPath) => {
      const runtime = claudePreflightRuntime({
        [settingsPath]: JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }),
      });

      await expect(claudePreflight(runtime)).resolves.toEqual({
        kind: 'refused',
        message:
          "Unsupported Claude credential selector 'CLAUDE_CODE_USE_BEDROCK'. Remove it and select an account with an absolute CLAUDE_CONFIG_DIR, or run Claude outside Coral.",
      });
      expect(runtime.runExact).not.toHaveBeenCalled();
    },
  );
});

describe('claudeArtifactCapability', () => {
  it('reconciles response loss without replaying the visible external effect', async () => {
    const runtime = new SimulationRuntime();
    const handle = '/tmp/claude-response-loss.jsonl';
    runtime.storage.mkdirSync('/tmp', { recursive: true });
    runtime.storage.writeFileSync(handle, '{}\n', { encoding: 'utf-8' });
    const unlink = vi.spyOn(runtime.storage, 'unlinkSync');
    const writeAtomicDurableSync = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
    let actionWrites = 0;
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockImplementation((...args) => {
      if (args[0].includes('.provider-artifact-discard') && ++actionWrites === 2) return false;
      return writeAtomicDurableSync(...args);
    });
    const cleanupRuntime: ArtifactCleanupRuntime = {
      storage: runtime.storage,
      process: runtime.process,
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
    expect(reconciled).toMatchObject({ kind: 'applied', outcome: { kind: 'discarded' } });
    if (reconciled.kind !== 'applied') await claudeArtifactCapability.discardArtifacts(action);
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});

describe('claudeAppServerLifecycle.send', () => {
  const continuity = { brokerSessionKey: 'broker-current', brokerTurnId: 'turn-current' };
  const input = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
  function transportFor(rpc: AppServerTransport['rpc']): AppServerTransport {
    return { rpc, subscribe: () => () => {}, closed: new Promise(() => {}) };
  }

  it.each([
    { state: 'delivered' },
    { state: 'refused', code: 'turn_not_started', reason: 'The print turn has not started.' },
    { state: 'refused', code: 'transport_unsupported', reason: 'TUI send is unsupported.' },
    { state: 'refused', code: 'turn_ended', reason: 'The print turn ended.' },
  ])('returns the answered broker outcome %j and uses retained broker continuity', async (outcome) => {
    const rpc = vi.fn().mockResolvedValue(outcome);
    await expect(claudeAppServerLifecycle.send!(transportFor(rpc), continuity, input)).resolves.toEqual(outcome);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('turn/send', { ...continuity, ...input });
  });

  it('maps an answered broker error to provider_rejected with its message', async () => {
    const error = new ProviderRpcError({
      requestId: 1,
      method: 'turn/send',
      rpcCode: -32003,
      providerMessage: 'provider refused this input',
      providerData: undefined,
      hostLog: { startSeq: 1, endSeq: 2 },
    });
    const rpc = vi.fn().mockRejectedValue(error);
    await expect(claudeAppServerLifecycle.send!(transportFor(rpc), continuity, input)).resolves.toEqual({
      state: 'refused',
      code: 'provider_rejected',
      reason: 'provider refused this input',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    {},
    { state: 'delivered', unexpected: true },
    { state: 'unknown', reason: 'not a broker outcome' },
  ])('keeps a malformed broker answer unknown without repeating the send: %j', async (answer) => {
    const rpc = vi.fn().mockResolvedValue(answer);
    await expect(claudeAppServerLifecycle.send!(transportFor(rpc), continuity, input)).resolves.toMatchObject({
      state: 'unknown',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing broker answer unknown without repeating the send', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('transport closed without an answer'));
    await expect(claudeAppServerLifecycle.send!(transportFor(rpc), continuity, input)).resolves.toEqual({
      state: 'unknown',
      reason: 'transport closed without an answer',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('refuses one-shot curation without job-owned continuity or contacting the transport', async () => {
    const rpc = vi.fn();
    const transport: AppServerTransport = {
      rpc: rpc as AppServerTransport['rpc'],
      subscribe: () => () => {},
      closed: new Promise(() => {}),
    };
    await expect(
      claudeAppServerLifecycle.send!(
        transport,
        {},
        {
          text: 'Change direction',
          clientMessageId: '33333333-3333-4333-8333-333333333333',
        },
      ),
    ).resolves.toMatchObject({ state: 'refused', code: 'transport_unsupported' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
