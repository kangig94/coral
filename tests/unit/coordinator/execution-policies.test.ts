import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_PREFLIGHT_TIMEOUT_MS,
  buildEffectiveCoralEnv,
  buildSessionControllerProfile,
  runProviderPreflight,
  toPreflightRuntime,
} from '#src/coordinator/services/execution-policies.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { CONTEXT_ENV_KEY } from '#src/transport/context-profile.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('execution policies', () => {
  it('bounds provider preflight before a launch can wait forever without a job id', async () => {
    const runtime = new SimulationRuntime();
    const preflight = vi.fn(
      () =>
        new Promise<void>(() => {
          // Deliberately unresolved to exercise the preflight timeout.
        }),
    );
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    const result = runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {}));
    await Promise.resolve();
    runtime.time.tick(PROVIDER_PREFLIGHT_TIMEOUT_MS);

    await expect(result).resolves.toContain('codex preflight timed out after 30000ms');
    expect(preflight).toHaveBeenCalledOnce();
  });

  it('passes only provider-opaque environment inputs to the bound preflight', async () => {
    const runtime = new SimulationRuntime({
      env: { PATH: '/bin', OPENAI_API_KEY: 'daemon-secret', CODEX_HOME: '/daemon/codex' },
    });
    const preflight = toPreflightRuntime(runtime, '/workspace/project', { CORAL_OWNER: 'reviewer' });

    expect(preflight).toMatchObject({
      cwd: '/workspace/project',
      baseEnv: { PATH: '/bin', OPENAI_API_KEY: 'daemon-secret', CODEX_HOME: '/daemon/codex' },
      requestEnv: { CORAL_OWNER: 'reviewer' },
      platform: runtime.env.platform(),
    });
    expect(preflight).not.toHaveProperty('credentialSource');
    expect(preflight).not.toHaveProperty('runExact');
  });

  it('resolves relative preflight working directories against the daemon cwd', async () => {
    const runtime = new SimulationRuntime();
    const preflight = toPreflightRuntime(runtime, 'nested/project', {});

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
