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

    const result = runProviderPreflight(provider, toPreflightRuntime(runtime));
    await Promise.resolve();
    runtime.time.tick(PROVIDER_PREFLIGHT_TIMEOUT_MS);

    await expect(result).resolves.toContain('codex preflight timed out after 30000ms');
    expect(provider.preflight).toHaveBeenCalledOnce();
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
