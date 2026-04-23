import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '../../../runtime/real.js';
import type { JobRuntime } from '../../../jobs/records.js';
import { LaunchCoordinator } from '../admission.js';

function createProviderServerScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    'const rl = createInterface({ input: process.stdin });',
    "rl.on('line', (line) => {",
    '  const msg = JSON.parse(line);',
    "  if (typeof msg.id === 'number' && msg.method === 'ping') {",
    "    process.stdout.write(JSON.stringify({ id: msg.id, result: { pong: msg.params?.value ?? null } }) + '\\n');",
    '    return;',
    '  }',
    "  if (msg.method === 'notify-back') {",
    "    process.stdout.write(JSON.stringify({ method: 'tick', params: msg.params ?? {} }) + '\\n');",
    '    return;',
    '  }',
    "  if (typeof msg.id === 'number') {",
    "    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'unknown method' } }) + '\\n');",
    '  }',
    '});',
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('');
}

async function waitForValue<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe('durable transport', () => {
  let coordinator: LaunchCoordinator;
  let tmpRoot: string;

  beforeEach(() => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    coordinator = new LaunchCoordinator({ runtime: createRealRuntime() });
    tmpRoot = mkdtempSync(join(tmpdir(), 'coral-live-durable-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.CORAL_MAX_WORKERS;
    delete process.env.CORAL_DISCUSS_MAX_WORKERS;
    coordinator.terminateAll();
    vi.restoreAllMocks();
  });

  it('streams durable-job progress and reports runtime metadata without sidecar files', async () => {
    const jobDir = join(tmpRoot, 'job-1');
    mkdirSync(jobDir, { recursive: true });
    const onEvent = vi.fn();
    const runtimeRecords: JobRuntime[] = [];

    const result = await coordinator.spawnDurableJob({
      provider: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdout.write(\'{"step":"one"}\\n\');',
          'setTimeout(() => process.stdout.write(\'{"step":"two"}\\n\'), 25);',
          "setTimeout(() => process.stderr.write('warn\\n'), 35);",
          'setTimeout(() => process.exit(0), 50);',
        ].join(''),
      ],
      jobDir,
      onEvent,
      onRuntimeRecord: (record) => {
        runtimeRecords.push(record);
      },
    });

    expect(result).toMatchObject({
      code: 0,
      aborted: false,
    });
    expect(result.stdout).toContain('{"step":"one"}');
    expect(result.stdout).toContain('{"step":"two"}');
    expect(result.stderr).toContain('warn');
    expect(onEvent).toHaveBeenCalledWith('{"step":"one"}');
    expect(onEvent).toHaveBeenCalledWith('{"step":"two"}');
    expect(existsSync(join(jobDir, 'runtime.json'))).toBe(false);
    expect(existsSync(join(jobDir, 'exit.json'))).toBe(false);
    const lastRuntime = runtimeRecords.at(-1);
    const tailWatermark = lastRuntime && 'tailWatermark' in lastRuntime ? lastRuntime.tailWatermark : undefined;
    expect(tailWatermark).toBeGreaterThan(0);
  });

  it('spawns a provider server with JSON-RPC transport and stable generation ids', async () => {
    const handle = await coordinator.spawnProviderServer({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', createProviderServerScript()],
    });

    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.generation).toBe(1);

    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const unsubscribe = handle.onNotification((message) => {
      notifications.push(message);
    });

    await expect(handle.rpc.request('ping', { value: 'pong' })).resolves.toEqual({ pong: 'pong' });
    handle.rpc.notify('notify-back', { ready: true });

    expect(await waitForValue(() => notifications[0] ?? null)).toEqual({
      method: 'tick',
      params: { ready: true },
    });

    unsubscribe();
    await handle.close();
  });

  it('terminateAll drains queued launches but does not kill provider servers', async () => {
    const handle = await coordinator.spawnProviderServer({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', createProviderServerScript()],
    });

    coordinator.terminateAll();

    await expect(handle.rpc.request('ping', { value: 'still-live' })).resolves.toEqual({
      pong: 'still-live',
    });
    await handle.close();
  });
});
