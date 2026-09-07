import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import type { JobRuntime } from '#src/jobs/records.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { PROVIDER_SERVER_MAX_JSONL_LINE_BYTES } from '#src/providers/app-server-transport.js';

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

function createOversizedProviderServerScript(): string {
  return [
    `process.stdout.write('x'.repeat(${PROVIDER_SERVER_MAX_JSONL_LINE_BYTES + 1}));`,
    'setInterval(() => {}, 1000);',
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
  let runtime: ReturnType<typeof createRealRuntime>;
  let tmpRoot: string;

  beforeEach(() => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    runtime = createRealRuntime('prod');
    coordinator = new LaunchCoordinator({ runtime });
    tmpRoot = mkdtempSync(join(tmpdir(), 'coral-live-durable-'));
  });

  afterEach(async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.CORAL_MAX_WORKERS;
    delete process.env.CORAL_DISCUSS_MAX_WORKERS;
    await coordinator.terminateAll();
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

  it('holds the provider result until an unattributable surviving descendant exits', async () => {
    const jobDir = join(tmpRoot, 'job-with-descendant');
    mkdirSync(jobDir, { recursive: true });

    const result = await coordinator.spawnDurableJob({
      provider: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], { stdio: 'ignore' });",
          "process.stdout.write(String(descendant.pid) + '\\n');",
          'descendant.unref();',
        ].join(''),
      ],
      jobDir,
    });

    const descendantPid = Number(result.stdout.trim());
    expect(result.code).toBe(0);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(runtime.process.observeLiveness(descendantPid)).toBe('absent');
  });

  it('spawns a provider server with JSON-RPC transport and stable generation ids', async () => {
    const handle = await coordinator.spawnProviderServer(
      {
        provider: 'codex',
        command: process.execPath,
        args: ['-e', createProviderServerScript()],
      },
      undefined,
      undefined,
      undefined,
      (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
    );
    if ('kind' in handle) throw new Error('Expected a contained provider server handle.');

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
    await handle.close((hold) => ({
      kind: 'accepted',
      owner: 'provider-host-manager',
      settlement: hold.settled,
    }));
  });

  it('closes provider servers that emit an oversized JSONL line', async () => {
    const handle = await coordinator.spawnProviderServer(
      {
        provider: 'codex',
        command: process.execPath,
        args: ['-e', createOversizedProviderServerScript()],
      },
      undefined,
      undefined,
      undefined,
      (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
    );
    if ('kind' in handle) throw new Error('Expected a contained provider server handle.');

    const outcome = await handle.closePromise;
    expect(outcome).toBeInstanceOf(Error);
    const error = outcome as Error & { data?: unknown };
    const data = error.data as { code?: string; maxLineBytes?: number; observedBytes?: number } | undefined;

    expect(error.message).toContain('emitted an oversized JSONL line');
    expect(data).toEqual(
      expect.objectContaining({
        code: 'provider_server_line_too_large',
        maxLineBytes: PROVIDER_SERVER_MAX_JSONL_LINE_BYTES,
      }),
    );
    expect(data?.observedBytes).toBeGreaterThan(PROVIDER_SERVER_MAX_JSONL_LINE_BYTES);
  });

  it('terminateAll drains queued launches but does not kill provider servers', async () => {
    const handle = await coordinator.spawnProviderServer(
      {
        provider: 'codex',
        command: process.execPath,
        args: ['-e', createProviderServerScript()],
      },
      undefined,
      undefined,
      undefined,
      (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
    );
    if ('kind' in handle) throw new Error('Expected a contained provider server handle.');

    await coordinator.terminateAll();

    await expect(handle.rpc.request('ping', { value: 'still-live' })).resolves.toEqual({
      pong: 'still-live',
    });
    await handle.close((hold) => ({
      kind: 'accepted',
      owner: 'provider-host-manager',
      settlement: hold.settled,
    }));
  });
});
