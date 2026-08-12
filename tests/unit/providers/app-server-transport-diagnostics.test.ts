import { afterEach, describe, expect, it } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { spawnProviderServerTransport, type ProviderServerHandle } from '#src/providers/app-server-transport.js';
import {
  appendProviderHostLog,
  createProviderHostDiagnostics,
  inspectProviderHostDiagnostics,
  PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT,
  PROVIDER_HOST_LOG_MAX_BYTES,
} from '#src/providers/host-diagnostics.js';

const TEST_TIMEOUT_MS = 20_000;

describe('provider app-server transport diagnostics', () => {
  const handles: ProviderServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
  });

  it('keeps pre-request history separate from the exact completed request span', async () => {
    const handle = await spawnScriptedServer(cursorScopeScript());
    await waitUntil(() => handle.inspectDiagnostics().hostLog.entries.length > 0);

    await expect(handle.rpc.request('succeed')).resolves.toEqual({ ok: true });
    handle.rpc.notify('append-after');
    await waitUntil(() => retainedText(handle).includes('after\n'));

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

  it('retains the completed failure observation for inspect after the request rejects', async () => {
    const handle = await spawnScriptedServer(cursorScopeScript());
    await waitUntil(() => handle.inspectDiagnostics().hostLog.entries.length > 0);

    await expect(handle.rpc.request('fail')).rejects.toThrow('fail failed');

    const snapshot = handle.inspectDiagnostics();
    expect(snapshot.completedObservations).toHaveLength(1);
    expect(snapshot.completedObservations[0]).toMatchObject({
      factSeq: 1,
      generation: 17,
      requestId: 1,
      method: 'fail',
      response: {
        kind: 'failure',
        rpcCode: -32_603,
        providerMessage: 'configuration refused',
        providerData: { reason: 'poisoned cwd' },
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.completedObservations)).toBe(true);
    expect(Object.isFrozen(snapshot.hostLog.entries)).toBe(true);
  });

  it(
    'caps retained UTF-8 host-log payload and marks incomplete request spans',
    async () => {
      const handle = await spawnScriptedServer(logFloodScript());

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
    },
    TEST_TIMEOUT_MS,
  );

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

  it(
    'caps completed observations at 256 facts and records the evicted fact cursor',
    async () => {
      const handle = await spawnScriptedServer(immediateSuccessScript());

      for (let request = 0; request <= PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT; request += 1) {
        await handle.rpc.request('succeed', { request });
      }

      const snapshot = handle.inspectDiagnostics();
      expect(snapshot.completedObservations).toHaveLength(PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT);
      expect(snapshot.factsTruncatedBeforeSeq).toBe(2);
      expect(snapshot.completedObservations[0]?.factSeq).toBe(2);
      expect(snapshot.completedObservations.at(-1)?.factSeq).toBe(PROVIDER_HOST_COMPLETED_OBSERVATION_LIMIT + 1);
    },
    TEST_TIMEOUT_MS,
  );

  async function spawnScriptedServer(script: string): Promise<ProviderServerHandle> {
    const handle = await spawnProviderServerTransport({
      runtime: createRealRuntime('prod'),
      options: {
        provider: 'test',
        command: process.execPath,
        args: ['-e', script],
      },
      generation: 17,
    });
    handles.push(handle);
    return handle;
  }
});

function cursorScopeScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    "process.stderr.write('historical\\n');",
    'const lines = createInterface({ input: process.stdin });',
    "lines.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  if (message.method === 'append-after') {",
    "    process.stderr.write('after\\n');",
    '    return;',
    '  }',
    "  process.stderr.write('during\\n');",
    "  if (message.method === 'fail') {",
    '    setTimeout(() => process.stdout.write(JSON.stringify({',
    '      id: message.id,',
    "      error: { code: -32603, message: 'configuration refused', data: { reason: 'poisoned cwd' } },",
    "    }) + '\\n'), 20);",
    '    return;',
    '  }',
    "  setTimeout(() => process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n'), 20);",
    '});',
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('');
}

function logFloodScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    'const lines = createInterface({ input: process.stdin });',
    "lines.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    `  const payload = 'x'.repeat(${PROVIDER_HOST_LOG_MAX_BYTES + 64 * 1024});`,
    '  process.stderr.write(payload, () => {',
    "    process.stdout.write(JSON.stringify({ id: message.id, result: { flooded: true } }) + '\\n');",
    '  });',
    '});',
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('');
}

function immediateSuccessScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    'const lines = createInterface({ input: process.stdin });',
    "lines.on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');",
    '});',
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('');
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
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
