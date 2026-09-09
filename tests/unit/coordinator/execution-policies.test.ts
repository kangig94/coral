import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS,
  PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS,
  buildEffectiveCoralEnv,
  buildSessionControllerProfile,
  runProviderPreflight,
  toPreflightRuntime,
} from '#src/coordinator/services/execution-policies.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { ProviderPreflightOutcome } from '#src/providers/contract.js';
import { CONTEXT_ENV_KEY } from '#src/transport/context-profile.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function pendingTimerCount(runtime: SimulationRuntime): number {
  return (runtime.time as unknown as { timers: Map<number, unknown> }).timers.size;
}

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
    await flushMicrotasks();
    runtime.time.tick(PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS + 1);

    await expect(result).resolves.toEqual({
      kind: 'undetermined',
      cause: 'deadline',
      message: `codex preflight timed out after ${PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS}ms`,
    });
    expect(preflight).toHaveBeenCalledOnce();
  });

  it('re-asks one provider non-answer and returns the next satisfied answer', async () => {
    const runtime = new SimulationRuntime();
    let settleFirstProbe!: (outcome: ProviderPreflightOutcome) => void;
    let settleSecondProbe!: (outcome: ProviderPreflightOutcome) => void;
    const preflight = vi
      .fn<() => Promise<ProviderPreflightOutcome>>()
      .mockImplementationOnce(
        () =>
          new Promise<ProviderPreflightOutcome>((resolve) => {
            settleFirstProbe = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ProviderPreflightOutcome>((resolve) => {
            settleSecondProbe = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: 'refused', message: 'third answer must not be observed' });
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;
    const sleep = vi.spyOn(runtime.time, 'sleep');
    const startedAt = runtime.time.monotonicNow();

    const result = runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {}));
    await flushMicrotasks(12);
    expect(preflight).toHaveBeenCalledOnce();

    runtime.time.tick(10_000);
    settleFirstProbe({ kind: 'undetermined', message: 'availability was not observed' });
    await flushMicrotasks(12);
    runtime.time.tick(PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS);
    await flushMicrotasks(12);
    expect(preflight).toHaveBeenCalledTimes(2);

    runtime.time.tick(15_000);
    settleSecondProbe({ kind: 'satisfied' });

    await expect(result).resolves.toEqual({ kind: 'satisfied' });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS);
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(runtime.time.monotonicNow() - startedAt).toBe(26_000n);
    expect(pendingTimerCount(runtime)).toBe(0);
  });

  it('returns the final provider non-answer before the budget without leaving pending work', async () => {
    const runtime = new SimulationRuntime();
    let activeProbes = 0;
    const preflight = vi.fn(async (): Promise<ProviderPreflightOutcome> => {
      activeProbes += 1;
      try {
        return { kind: 'undetermined', message: 'availability was not observed' };
      } finally {
        activeProbes -= 1;
      }
    });
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;
    const startedAt = runtime.time.monotonicNow();
    const result = runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {}));
    await flushMicrotasks(12);

    for (
      let elapsed = PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS;
      elapsed < PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS;
      elapsed += PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS
    ) {
      runtime.time.tick(PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS);
      await flushMicrotasks(12);
    }

    await expect(result).resolves.toEqual({
      kind: 'undetermined',
      cause: 'provider',
      message: 'availability was not observed',
    });
    expect(runtime.time.monotonicNow() - startedAt).toBeLessThan(BigInt(PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS));
    expect(activeProbes).toBe(0);
    expect(pendingTimerCount(runtime)).toBe(0);
    expect(preflight).toHaveBeenCalledTimes(
      PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS / PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS + 1,
    );
    const completedInvocations = preflight.mock.calls.length;
    await flushMicrotasks(12);
    expect(preflight).toHaveBeenCalledTimes(completedInvocations);
  });

  it('expires a hanging retry at the original deadline without starting a third probe', async () => {
    const runtime = new SimulationRuntime();
    const preflight = vi
      .fn<() => Promise<ProviderPreflightOutcome>>()
      .mockResolvedValueOnce({ kind: 'undetermined', message: 'availability was not observed' })
      .mockImplementationOnce(
        () =>
          new Promise<ProviderPreflightOutcome>(() => {
            // The retry must remain in flight until the original deadline settles the policy.
          }),
      )
      .mockResolvedValueOnce({ kind: 'satisfied' });
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    const result = runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {}));
    await flushMicrotasks(12);
    expect(preflight).toHaveBeenCalledOnce();

    runtime.time.tick(PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS);
    await flushMicrotasks(12);
    expect(preflight).toHaveBeenCalledTimes(2);

    runtime.time.tick(PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS - PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS);

    await expect(result).resolves.toEqual({
      kind: 'undetermined',
      cause: 'deadline',
      message: `codex preflight timed out after ${PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS}ms`,
    });
    expect(preflight).toHaveBeenCalledTimes(2);
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

  it('uses a short positive remainder for one immediate decisive re-ask', async () => {
    const runtime = new SimulationRuntime();
    let settleFirstProbe!: (outcome: ProviderPreflightOutcome) => void;
    const preflight = vi
      .fn<() => Promise<ProviderPreflightOutcome>>()
      .mockImplementationOnce(
        () =>
          new Promise<ProviderPreflightOutcome>((resolve) => {
            settleFirstProbe = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: 'satisfied' })
      .mockResolvedValueOnce({ kind: 'refused', message: 'third answer must not be observed' });
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;
    const sleep = vi.spyOn(runtime.time, 'sleep');
    const result = runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {}));
    await flushMicrotasks(12);

    runtime.time.tick(PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS - Math.floor(PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS / 2));
    settleFirstProbe({ kind: 'undetermined', message: 'availability was not observed' });

    await expect(result).resolves.toEqual({ kind: 'satisfied' });
    expect(sleep).not.toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(pendingTimerCount(runtime)).toBe(0);
  });

  it('rejects a thrown preflight fault with its documented code without retrying', async () => {
    const runtime = new SimulationRuntime();
    const preflight = vi.fn(async () => {
      throw new Error('preflight implementation failed');
    });
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    await expect(
      runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {})),
    ).rejects.toMatchObject({
      code: 'provider_preflight_faulted',
      context: {
        provider: 'codex',
        cause: 'preflight implementation failed',
      },
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(pendingTimerCount(runtime)).toBe(0);
  });

  it('rejects a malformed fulfilled outcome with the documented fault instead of hanging', async () => {
    const runtime = new SimulationRuntime();
    const provider = {
      name: 'codex',
      preflight: vi.fn(async () => undefined as never),
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    await expect(
      runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {})),
    ).rejects.toMatchObject({
      code: 'provider_preflight_faulted',
      context: {
        provider: 'codex',
        cause: expect.stringMatching(/kind/iu),
      },
    });
    expect(provider.preflight).toHaveBeenCalledOnce();
    expect(pendingTimerCount(runtime)).toBe(0);
  });

  it('rejects an outcome that settles after the deadline before its timer callback runs', async () => {
    const runtime = new SimulationRuntime();
    let monotonicTime = 0n;
    vi.spyOn(runtime.time, 'monotonicNow').mockImplementation(() => monotonicTime);
    let settleProbe!: (outcome: ProviderPreflightOutcome) => void;
    const preflight = vi.fn(
      () =>
        new Promise<ProviderPreflightOutcome>((resolve) => {
          settleProbe = resolve;
        }),
    );
    const provider = {
      name: 'codex',
      preflight,
    } as Pick<BoundProvider, 'name' | 'preflight'>;

    const result = runProviderPreflight(provider as BoundProvider, toPreflightRuntime(runtime, '/workspace', {}));
    await flushMicrotasks(12);
    expect(pendingTimerCount(runtime)).toBe(1);

    monotonicTime = BigInt(PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS + 1);
    settleProbe({ kind: 'satisfied' });

    await expect(result).resolves.toEqual({
      kind: 'undetermined',
      cause: 'deadline',
      message: `codex preflight timed out after ${PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS}ms`,
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(pendingTimerCount(runtime)).toBe(0);
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
