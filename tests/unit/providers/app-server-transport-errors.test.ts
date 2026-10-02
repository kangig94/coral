import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderHostFault,
  spawnProviderServerTransport,
  type ProviderServerHandle,
} from '#src/providers/app-server-transport.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { type MockChildProcess } from '#tools/simulation/core/mock-process.js';
const acceptCleanupHold: Parameters<ProviderServerHandle['close']>[0] = (hold) => ({
  kind: 'accepted',
  owner: 'provider-proxy-root-pool',
  settlement: hold.settled,
});

describe('provider app-server transport errors', () => {
  const handles: ProviderServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close(acceptCleanupHold)));
  });

  it('reports invalid provider protocol as a host fault with a diagnostic reference', async () => {
    const handle = await spawnScriptedServer('invalid');
    const outcome = await handle.closePromise;

    expect(outcome).toBeInstanceOf(ProviderHostFault);
    const fault = outcome as ProviderHostFault;

    expect(fault).toMatchObject({
      provider: 'test',
      detail: 'emitted invalid JSONL',
      data: { line: 'not-json' },
      diagnosticRef: { generation: 17 },
    });
    expect(fault.message).not.toContain('protocol diagnostic line');
    expect(retainedDiagnosticRefText(fault)).toContain('protocol diagnostic line\n');
  });

  it('reports unexpected process exit as a host fault with the same diagnostic evidence boundary', async () => {
    const handle = await spawnScriptedServer('exit');
    const outcome = await handle.closePromise;

    expect(outcome).toBeInstanceOf(ProviderHostFault);
    const fault = outcome as ProviderHostFault;
    expect(fault.detail).toBe('exited unexpectedly (exit 7)');
    expect(fault.message).not.toContain('process diagnostic line');
    expect(retainedDiagnosticRefText(fault)).toContain('process diagnostic line\n');
  });

  async function spawnScriptedServer(mode: 'invalid' | 'exit'): Promise<ProviderServerHandle> {
    const runtime = new SimulationRuntime();
    let child!: MockChildProcess;
    let close!: () => void;
    runtime.spawner.enqueueSpawn({
      close: null,
      onSpawn: (context) => {
        child = context.child as MockChildProcess;
        close = () => context.close({ code: 7 });
      },
    });
    const handle = await spawnProviderServerTransport({
      runtime,
      options: { provider: 'test', command: 'controlled-server', args: [] },
      generation: 17,
      observeProviderResponse: () => {},
      acceptFailedSpawnCleanup: acceptCleanupHold,
    });
    if ('kind' in handle) throw handle.error;
    handles.push(handle);
    child.pushStderr(mode === 'invalid' ? 'protocol diagnostic line\n' : 'process diagnostic line\n');
    if (mode === 'invalid') child.pushStdout('not-json\n');
    else close();
    return handle;
  }
});

function retainedDiagnosticRefText(fault: ProviderHostFault): string {
  return fault.diagnosticRef
    .inspect()
    .hostLog.entries.map((entry) => entry.text)
    .join('');
}
