import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS,
  buildEffectiveCoralEnv,
  buildSessionControllerProfile,
  runProviderPreflight,
  toPreflightRuntime,
} from '#src/coordinator/services/execution-policies.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { ProviderPreflightOutcome } from '#src/providers/contract.js';
import { CONTEXT_ENV_KEY } from '#src/transport/context-profile.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('execution policies', () => {
  it('bounds provider preflight before a launch can wait forever without a job id', async () => {
    const runtime = new SimulationRuntime();
    const preflight = vi.fn(
      () =>
        new Promise<ProviderPreflightOutcome>(() => {
          // Deliberately unresolved to exercise the preflight timeout.
        }),
    );
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    const result = runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {}));
    await Promise.resolve();
    runtime.time.tick(PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS + 1);

    await expect(result).resolves.toEqual({
      kind: 'undetermined',
      cause: 'deadline',
      message: `codex preflight timed out after ${PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS}ms`,
    });
    expect(preflight).toHaveBeenCalledOnce();
  });

  it('returns a satisfied provider outcome as a satisfied decision', async () => {
    const runtime = new SimulationRuntime();
    const provider = {
      name: 'codex',
      preflight: vi.fn(async () => ({ kind: 'satisfied' }) as const),
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    await expect(
      runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {})),
    ).resolves.toEqual({ kind: 'satisfied' });
  });

  it('returns a refused provider outcome as a refused decision', async () => {
    const runtime = new SimulationRuntime();
    const provider = {
      name: 'codex',
      preflight: vi.fn(async () => ({ kind: 'refused', message: 'credentials are invalid' }) as const),
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    await expect(
      runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {})),
    ).resolves.toEqual({ kind: 'refused', message: 'credentials are invalid' });
  });

  it('classifies an undetermined provider outcome with the provider cause', async () => {
    const runtime = new SimulationRuntime();
    const provider = {
      name: 'codex',
      preflight: vi.fn(async () => ({ kind: 'undetermined', message: 'availability was not observed' }) as const),
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    await expect(
      runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {})),
    ).resolves.toEqual({
      kind: 'undetermined',
      cause: 'provider',
      message: 'availability was not observed',
    });
  });

  it('classifies a thrown non-verdict with the faulted cause', async () => {
    const runtime = new SimulationRuntime();
    const provider = {
      name: 'codex',
      preflight: vi.fn(async () => {
        throw new Error('preflight implementation failed');
      }),
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    await expect(
      runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {})),
    ).resolves.toEqual({
      kind: 'undetermined',
      cause: 'faulted',
      message: 'preflight implementation failed',
    });
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
    expect(preflight).not.toHaveProperty('access');
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
