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
import { createRealRuntime } from '#src/runtime/real.js';

describe('provider response silence', () => {
  const handles: ProviderServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
  });

  it('publishes no observation or classifier finding while a request remains unsettled', async () => {
    const recorder = createCodexObservationRecorder();
    const handle = await spawnScriptedServer(muteServerScript(), recorder.observe);
    const requestOutcome = rejectionOf(handle.rpc.request('config/read'));

    await waitUntil(() => retainedText(handle).includes('request accepted\n'));

    expect(recorder.observations).toHaveLength(0);
    expect(recorder.findings).toHaveLength(0);
    expect(handle.inspectDiagnostics().completedObservations).toHaveLength(0);

    await handle.close();
    expect(await requestOutcome).toBeInstanceOf(ProviderHostFault);
  });

  it('publishes no observation or classifier finding for a process fault', async () => {
    const recorder = createCodexObservationRecorder();
    const handle = await spawnScriptedServer(processFaultScript(), recorder.observe);

    const requestOutcome = await rejectionOf(handle.rpc.request('config/read'));
    const closeOutcome = await handle.closePromise;

    expect(requestOutcome).toBeInstanceOf(ProviderHostFault);
    expect(closeOutcome).toBeInstanceOf(ProviderHostFault);
    expect(recorder.observations).toHaveLength(0);
    expect(recorder.findings).toHaveLength(0);
    expect(handle.inspectDiagnostics().completedObservations).toHaveLength(0);
  });

  async function spawnScriptedServer(
    script: string,
    observeProviderResponse: ProviderResponseObservationSink,
  ): Promise<ProviderServerHandle> {
    const handle = await spawnProviderServerTransport({
      runtime: createRealRuntime('prod'),
      options: {
        provider: 'codex',
        command: process.execPath,
        args: ['-e', script],
      },
      generation: 17,
      observeProviderResponse,
    });
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

function muteServerScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    'const lines = createInterface({ input: process.stdin });',
    "lines.on('line', () => process.stderr.write('request accepted\\n'));",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('');
}

function processFaultScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    'const lines = createInterface({ input: process.stdin });',
    "lines.on('line', () => process.stderr.write('request accepted\\n', () => process.exit(7)));",
  ].join('');
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected provider request to reject.');
    },
    (error: unknown) => error,
  );
}

function retainedText(handle: ProviderServerHandle): string {
  return handle
    .inspectDiagnostics()
    .hostLog.entries.map((entry) => entry.text)
    .join('');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
