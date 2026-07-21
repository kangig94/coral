import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_PREFLIGHT_TIMEOUT_MS,
  buildEffectiveCoralEnv,
  buildSessionControllerProfile,
  runProviderPreflight,
  toPreflightRuntime,
} from '#src/coordinator/services/execution-policies.js';
import type { ProviderSpec } from '#src/providers/contract.js';
import { CONTEXT_ENV_KEY } from '#src/transport/context-profile.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { TEST_CODEX_SOURCE } from '../../helpers/provider-credentials.js';

describe('execution policies', () => {
  it('bounds provider preflight before a launch can wait forever without a job id', async () => {
    const runtime = new SimulationRuntime();
    const provider: ProviderSpec = {
      name: 'codex',
      run: {} as ProviderSpec['run'],
      preflight: vi.fn(
        () =>
          new Promise<void>(() => {
            // Deliberately unresolved to exercise the preflight timeout.
          }),
      ),
    };

    const result = runProviderPreflight(provider, toPreflightRuntime(runtime, TEST_CODEX_SOURCE, '/workspace', {}));
    await Promise.resolve();
    runtime.time.tick(PROVIDER_PREFLIGHT_TIMEOUT_MS);

    await expect(result).resolves.toContain('codex preflight timed out after 30000ms');
    expect(provider.preflight).toHaveBeenCalledOnce();
  });

  it('runs preflight with the selected source and no daemon credential overrides', async () => {
    const runtime = new SimulationRuntime({
      env: { PATH: '/bin', OPENAI_API_KEY: 'daemon-secret', CODEX_HOME: '/daemon/codex' },
    });
    const exec = vi.spyOn(runtime.process, 'exec').mockResolvedValue({
      stdout: '',
      stderr: '',
      status: 0,
    });
    const source = { ...TEST_CODEX_SOURCE, home: '/accounts/codex-a' };
    const preflight = toPreflightRuntime(runtime, source, '/workspace/project', {});

    await preflight.runExact('codex', ['app-server', '--help'], { timeout: 10_000 });

    expect(exec).toHaveBeenCalledWith('codex', ['app-server', '--help'], {
      timeout: 10_000,
      cwd: '/workspace/project',
      env: { PATH: '/bin', HOME: expect.any(String), CODEX_HOME: '/accounts/codex-a' },
    });
  });

  it('resolves relative preflight working directories against the daemon cwd', async () => {
    const runtime = new SimulationRuntime();
    const preflight = toPreflightRuntime(runtime, TEST_CODEX_SOURCE, 'nested/project', {});

    expect(preflight.cwd).toBe(`${runtime.env.cwd()}/nested/project`);
  });

  it('keeps Claude transport in request env but not the stored session controller profile', () => {
    const coralEnv = {
      [CONTEXT_ENV_KEY.owner]: 'alice',
      [CONTEXT_ENV_KEY.effort]: 'high',
      [CONTEXT_ENV_KEY.claudeModelCap]: 'opus',
      [CONTEXT_ENV_KEY.claudeTransport]: 'print',
    };

    expect(buildEffectiveCoralEnv(coralEnv)).toMatchObject({
      [CONTEXT_ENV_KEY.claudeTransport]: 'print',
    });
    expect(buildSessionControllerProfile(coralEnv)).toEqual({
      owner: 'alice',
      effort: 'high',
      claudeModelCap: 'opus',
    });
  });
});
