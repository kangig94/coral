import { afterEach, describe, expect, it } from 'vitest';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { type MockChildProcess, type MockStdin } from '#tools/simulation/core/mock-process.js';
import { spawnProviderServerTransport, type ProviderServerHandle } from '#src/providers/app-server-transport.js';
import {
  appendProviderHostLog,
  createProviderHostDiagnostics,
  inspectProviderHostDiagnostics,
  PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT,
  PROVIDER_HOST_LOG_MAX_BYTES,
  type ProviderResponseDiagnosticFact,
  type ProviderResponseObservationSink,
} from '#src/providers/host-diagnostics.js';

const acceptCleanupHold: Parameters<ProviderServerHandle['close']>[0] = (hold) => ({
  kind: 'accepted',
  owner: 'provider-proxy-root-pool',
  settlement: hold.settled,
});

describe('provider app-server transport diagnostics', () => {
  const handles: ProviderServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close(acceptCleanupHold)));
  });

  it('keeps pre-request history separate from the exact completed request span', async () => {
    const handle = await spawnScriptedServer('scoped');

    await expect(handle.rpc.request('succeed')).resolves.toEqual({ ok: true });
    handle.rpc.notify('append-after');

    const snapshot = handle.inspectDiagnostics();
    const observation = snapshot.completedObservations[0];
    expect(observation).toMatchObject({
      factSeq: 1,
      generation: 17,
      requestId: 1,
      method: 'succeed',
      response: { kind: 'success' },
      hostLog: { truncated: false },
    });
    expect(observation?.hostLog.historical.map((entry) => entry.text).join('')).toBe('historical\n');
    expect(observation?.hostLog.during.map((entry) => entry.text).join('')).toBe('during\n');
    expect(observation?.hostLog.after.map((entry) => entry.text).join('')).toBe('after\n');
    expect(observation?.hostLog.historical.every((entry) => entry.seq <= observation.hostLog.startSeq)).toBe(true);
    expect(
      observation?.hostLog.during.every(
        (entry) => observation.hostLog.startSeq < entry.seq && entry.seq <= observation.hostLog.endSeq,
      ),
    ).toBe(true);
    expect(observation?.hostLog.after.every((entry) => entry.seq > observation.hostLog.endSeq)).toBe(true);
  });

  it('publishes exactly one canonical fact before settling each completed provider response', async () => {
    const observations: ProviderResponseDiagnosticFact[] = [];
    const order: string[] = [];
    const handle = await spawnScriptedServer('scoped', (fact) => {
      observations.push(fact);
      order.push(`observed:${fact.requestId}`);
    });

    await handle.rpc.request('succeed').then(() => order.push('resolved:1'));
    await handle.rpc.request('fail').then(
      () => order.push('resolved:2'),
      () => order.push('rejected:2'),
    );

    expect(order).toEqual(['observed:1', 'resolved:1', 'observed:2', 'rejected:2']);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toEqual({
      factSeq: 1,
      generation: 17,
      requestId: 1,
      method: 'succeed',
      response: { kind: 'success' },
      hostLog: { startSeq: 1, endSeq: 2 },
    });
    expect(observations[1]).toEqual({
      factSeq: 2,
      generation: 17,
      requestId: 2,
      method: 'fail',
      response: {
        kind: 'failure',
        rpcCode: -32_603,
        providerMessage: 'configuration refused',
        providerData: { reason: 'poisoned cwd' },
      },
      hostLog: { startSeq: 2, endSeq: 3 },
    });
  });

  it('caps retained UTF-8 host-log payload and marks incomplete request spans', async () => {
    const handle = await spawnScriptedServer('flood');

    await expect(handle.rpc.request('flood')).resolves.toEqual({ flooded: true });

    const snapshot = handle.inspectDiagnostics();
    const retainedBytes = snapshot.hostLog.entries.reduce(
      (total, entry) => total + Buffer.byteLength(entry.text, 'utf8'),
      0,
    );
    expect(snapshot.hostLog.retainedBytes).toBe(retainedBytes);
    expect(retainedBytes).toBeLessThanOrEqual(PROVIDER_HOST_LOG_MAX_BYTES);
    expect(snapshot.hostLog.truncatedBeforeSeq).toBeGreaterThan(0);
    expect(snapshot.completedObservations[0]?.hostLog.truncated).toBe(true);
  });

  it('retains a valid UTF-8 tail when one log entry alone exceeds the byte budget', () => {
    const state = createProviderHostDiagnostics();
    appendProviderHostLog(state, {
      observedAt: 123,
      stream: 'stderr',
      text: `prefix:${'😀'.repeat(Math.ceil(PROVIDER_HOST_LOG_MAX_BYTES / 4) + 2)}`,
    });

    const snapshot = inspectProviderHostDiagnostics(state);
    const entry = snapshot.hostLog.entries[0];
    expect(snapshot.hostLog.entries).toHaveLength(1);
    expect(entry?.startTruncated).toBe(true);
    expect(snapshot.hostLog.truncatedBeforeSeq).toBe(entry?.seq);
    expect(snapshot.hostLog.retainedBytes).toBeLessThanOrEqual(PROVIDER_HOST_LOG_MAX_BYTES);
    expect(entry?.text).not.toContain('�');
    expect(entry?.text.endsWith('😀')).toBe(true);
  });

  it('caps completed observations at 256 facts and records the evicted fact cursor', async () => {
    const handle = await spawnScriptedServer('success');

    for (let request = 0; request <= PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT; request += 1) {
      await handle.rpc.request('succeed', { request });
    }

    const snapshot = handle.inspectDiagnostics();
    expect(snapshot.completedObservations).toHaveLength(PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT);
    expect(snapshot.factsTruncatedBeforeSeq).toBe(2);
    expect(snapshot.completedObservations[0]?.factSeq).toBe(2);
    expect(snapshot.completedObservations.at(-1)?.factSeq).toBe(PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT + 1);
  });

  async function spawnScriptedServer(
    mode: 'scoped' | 'flood' | 'success',
    observeProviderResponse: ProviderResponseObservationSink = () => {},
  ): Promise<ProviderServerHandle> {
    const runtime = new SimulationRuntime();
    let child!: MockChildProcess;
    runtime.spawner.enqueueSpawn({
      close: null,
      onSpawn: (context) => {
        child = context.child as MockChildProcess;
        (child.stdin as MockStdin).on('write', (line: string) => {
          const message = JSON.parse(line);
          if (message.method === 'append-after') {
            child.pushStderr('after\n');
            return;
          }
          if (mode === 'scoped') child.pushStderr('during\n');
          if (mode === 'flood') child.pushStderr('x'.repeat(PROVIDER_HOST_LOG_MAX_BYTES + 1));
          child.pushStdout(
            JSON.stringify({
              id: message.id,
              ...(message.method === 'fail'
                ? { error: { code: -32603, message: 'configuration refused', data: { reason: 'poisoned cwd' } } }
                : { result: mode === 'flood' ? { flooded: true } : { ok: true } }),
            }) + '\n',
          );
        });
      },
    });
    const handle = await spawnProviderServerTransport({
      runtime,
      options: { provider: 'test', command: 'controlled-server', args: [] },
      generation: 17,
      observeProviderResponse,
      acceptFailedSpawnCleanup: acceptCleanupHold,
    });
    if ('kind' in handle) throw handle.error;
    handles.push(handle);
    if (mode === 'scoped') child.pushStderr('historical\n');
    return handle;
  }
});
