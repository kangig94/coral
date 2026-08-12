import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderHostFault,
  ProviderRpcError,
  spawnProviderServerTransport,
  type ProviderServerHandle,
} from '#src/providers/app-server-transport.js';
import { createRealRuntime } from '#src/runtime/real.js';

const FOREIGN_HOST_LINE = 'bubblewrap: warning emitted before config/read\n';

describe('provider app-server transport errors', () => {
  const handles: ProviderServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
  });

  it('reports the provider RPC cause without an unrelated earlier bubblewrap warning', async () => {
    const handle = await spawnScriptedServer(rejectedRequestScript());
    await waitUntil(() => retainedDiagnosticText(handle).includes(FOREIGN_HOST_LINE));

    const error = await rejectionOf(handle.rpc.request('config/read'));

    expect(error).toBeInstanceOf(ProviderRpcError);
    expect(error).toMatchObject({
      requestId: 1,
      method: 'config/read',
      rpcCode: -32_603,
      providerMessage: 'configuration refused',
      providerData: { reason: 'poisoned cwd' },
      hostLog: { startSeq: 1, endSeq: 1 },
    });
    expect((error as Error).message).not.toContain('bubblewrap: warning emitted before config/read');
    expect((error as Error).message).toBe(
      'config/read failed [code=-32603]: configuration refused; data={"reason":"poisoned cwd"}',
    );
  });

  it('reports invalid provider protocol as a host fault with a diagnostic reference', async () => {
    const handle = await spawnScriptedServer(invalidProtocolScript());
    const outcome = await handle.closePromise;

    expect(outcome).toBeInstanceOf(ProviderHostFault);
    const fault = outcome as ProviderHostFault;
    await waitUntil(() => retainedDiagnosticRefText(fault).includes('protocol diagnostic line\n'));

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
    const handle = await spawnScriptedServer(unexpectedExitScript());
    const outcome = await handle.closePromise;

    expect(outcome).toBeInstanceOf(ProviderHostFault);
    const fault = outcome as ProviderHostFault;
    expect(fault.detail).toBe('exited unexpectedly (exit 7)');
    expect(fault.message).not.toContain('process diagnostic line');
    expect(retainedDiagnosticRefText(fault)).toContain('process diagnostic line\n');
  });

  async function spawnScriptedServer(script: string): Promise<ProviderServerHandle> {
    const handle = await spawnProviderServerTransport({
      runtime: createRealRuntime('prod'),
      options: {
        provider: 'test',
        command: process.execPath,
        args: ['-e', script],
      },
      generation: 17,
      observeProviderResponse: () => {},
    });
    handles.push(handle);
    return handle;
  }
});

function rejectedRequestScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    `process.stderr.write(${JSON.stringify(FOREIGN_HOST_LINE)});`,
    'const lines = createInterface({ input: process.stdin });',
    "lines.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    '  process.stdout.write(JSON.stringify({',
    '    id: message.id,',
    "    error: { code: -32603, message: 'configuration refused', data: { reason: 'poisoned cwd' } },",
    "  }) + '\\n');",
    '});',
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('');
}

function invalidProtocolScript(): string {
  return [
    "process.stderr.write('protocol diagnostic line\\n', () => process.stdout.write('not-json\\n'));",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1_000);',
  ].join('');
}

function unexpectedExitScript(): string {
  return "process.stderr.write('process diagnostic line\\n', () => process.exit(7));";
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected provider request to reject.');
    },
    (error: unknown) => error,
  );
}

function retainedDiagnosticText(handle: ProviderServerHandle): string {
  return handle
    .inspectDiagnostics()
    .hostLog.entries.map((entry) => entry.text)
    .join('');
}

function retainedDiagnosticRefText(fault: ProviderHostFault): string {
  return fault.diagnosticRef
    .inspect()
    .hostLog.entries.map((entry) => entry.text)
    .join('');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
