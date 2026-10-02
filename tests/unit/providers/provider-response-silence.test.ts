import { afterEach, describe, expect, it } from 'vitest';

import {
  ProviderHostFault,
  spawnProviderServerTransport,
  type ProviderServerHandle,
} from '#src/providers/app-server-transport.js';
import { classifyProviderResponseServiceability } from '#src/providers/serviceability.js';
import type {
  ProviderResponseDiagnosticFact,
  ProviderResponseObservationSink,
} from '#src/providers/host-diagnostics.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { type MockChildProcess, type MockStdin } from '#tools/simulation/core/mock-process.js';

const acceptCleanupHold: Parameters<ProviderServerHandle['close']>[0] = (hold) => ({
  kind: 'accepted',
  owner: 'provider-proxy-root-pool',
  settlement: hold.settled,
});

describe('provider response silence', () => {
  const handles: ProviderServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close(acceptCleanupHold)));
  });

  it('publishes no observation or classifier finding while a request remains unsettled', async () => {
    const recorder = createCodexObservationRecorder();
    const handle = await spawnScriptedServer('mute', recorder.observe);
    const requestOutcome = rejectionOf(handle.rpc.request('config/read'));

    expect(handle.inspectDiagnostics().hostLog.entries[0]?.text).toBe('request accepted\n');

    expect(recorder.observations).toHaveLength(0);
    expect(recorder.findings).toHaveLength(0);
    expect(handle.inspectDiagnostics().completedObservations).toHaveLength(0);

    await handle.close(acceptCleanupHold);
    expect(await requestOutcome).toBeInstanceOf(ProviderHostFault);
  });

  it('publishes no observation or classifier finding for a process fault', async () => {
    const recorder = createCodexObservationRecorder();
    const handle = await spawnScriptedServer('fault', recorder.observe);

    const requestOutcome = await rejectionOf(handle.rpc.request('config/read'));
    const closeOutcome = await handle.closePromise;

    expect(requestOutcome).toBeInstanceOf(ProviderHostFault);
    expect(closeOutcome).toBeInstanceOf(ProviderHostFault);
    expect(recorder.observations).toHaveLength(0);
    expect(recorder.findings).toHaveLength(0);
    expect(handle.inspectDiagnostics().completedObservations).toHaveLength(0);
  });

  async function spawnScriptedServer(
    mode: 'mute' | 'fault',
    observeProviderResponse: ProviderResponseObservationSink,
  ): Promise<ProviderServerHandle> {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({
      close: null,
      onSpawn: (context) => {
        const child = context.child as MockChildProcess;
        (child.stdin as MockStdin).on('write', () => {
          child.pushStderr('request accepted\n');
          if (mode === 'fault') context.close({ code: 7 });
        });
      },
    });
    const handle = await spawnProviderServerTransport({
      runtime,
      options: { provider: 'codex', command: 'controlled-server', args: [] },
      generation: 17,
      observeProviderResponse,
      acceptFailedSpawnCleanup: acceptCleanupHold,
    });
    if ('kind' in handle) throw handle.error;
    handles.push(handle);
    return handle;
  }
});

function createCodexObservationRecorder(): {
  observations: ProviderResponseDiagnosticFact[];
  findings: ReturnType<typeof classifyProviderResponseServiceability>[];
  observe: ProviderResponseObservationSink;
} {
  const observations: ProviderResponseDiagnosticFact[] = [];
  const findings: ReturnType<typeof classifyProviderResponseServiceability>[] = [];
  return {
    observations,
    findings,
    observe: (fact) => {
      observations.push(fact);
      findings.push(classifyProviderResponseServiceability('codex', fact));
    },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected provider request to reject.');
    },
    (error: unknown) => error,
  );
}
