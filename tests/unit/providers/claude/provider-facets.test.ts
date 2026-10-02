import { describe, expect, it, vi } from 'vitest';
import { TEST_CLAUDE_ACCESS } from '../../../helpers/provider-credentials.js';
import { claudePreflight } from '#src/providers/claude/provider-facets.js';
import { claudeArtifactCapability } from '#src/providers/claude/artifacts.js';
import type { ArtifactCleanupRuntime, ProviderPreflightRuntime } from '#src/providers/contract.js';
import type { ClaudeProviderAccess } from '#src/providers/claude/execution-plan.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

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
});
