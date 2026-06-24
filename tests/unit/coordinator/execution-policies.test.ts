import { describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_PREFLIGHT_TIMEOUT_MS,
  runProviderPreflight,
  toPreflightRuntime,
} from '#src/coordinator/services/execution-policies.js';
import type { ProviderSpec } from '#src/providers/contract.js';
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
});
