import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchCoordinator } from '../../coordinator/live/admission.js';
import { loadRecording, recordSpawn, saveRecording } from '../../infra/process/spawn-recording.js';
import type { ChildProcessLike } from '../../runtime/ports.js';
import { recordingToDurableScript, recordingToSpawnScript } from '../recording.js';
import { SimulationRuntime } from '../runtime.js';
import { createMockAppServerSpawnScript } from '../core/mock-app.js';
import { flushMicrotasks } from '../core/virtual-time.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function advance(runtime: SimulationRuntime, ms: number): Promise<void> {
  runtime.time.tick(ms);
  await flushMicrotasks();
}

function waitForChildClose(child: ChildProcessLike): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('simulation app-server and recording', () => {
  it('runs a scripted app-server JSON-RPC exchange through MockProcessSpawner', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn(
      createMockAppServerSpawnScript({
        threadStart: {
          response: {
            thread: {
              id: 'thread-123',
              name: 'Scripted Thread',
            },
          },
          delayMs: 2,
        },
        turnCreate: {
          delayMs: 1,
          events: [
            {
              type: 'item/started',
              data: {
                item: {
                  type: 'webSearch',
                  query: 'coral test',
                },
              },
              delayMs: 2,
            },
          ],
          result: {
            content: 'final response',
          },
        },
        shutdown: {
          delayMs: 1,
        },
      }),
    );

    const coordinator = new LaunchCoordinator({ runtime });
    const handlePromise = coordinator.spawnProviderServer({
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/tmp/sim/project',
      initializeRequest: {
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'test',
            version: '0.0.1',
          },
        },
      },
    });

    await advance(runtime, 0);
    const handle = await handlePromise;
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const unsubscribe = handle.onNotification((message) => {
      notifications.push(message);
    });

    const threadPromise = handle.rpc.request('thread/start', {
      cwd: '/tmp/sim/project',
      model: null,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    });
    await advance(runtime, 2);
    await expect(threadPromise).resolves.toEqual({
      thread: {
        id: 'thread-123',
        name: 'Scripted Thread',
      },
    });

    const turnPromise = handle.rpc.request('turn/start', {
      threadId: 'thread-123',
      input: [{ type: 'text', text: 'Hello from test', text_elements: [] }],
      model: null,
    });
    await advance(runtime, 1);
    await expect(turnPromise).resolves.toMatchObject({
      turn: {
        id: 'mock-turn-1',
        status: 'inProgress',
      },
    });

    await advance(runtime, 2);
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'thread/started',
          params: expect.objectContaining({
            threadId: 'thread-123',
          }),
        }),
        expect.objectContaining({
          method: 'turn/started',
          params: expect.objectContaining({
            threadId: 'thread-123',
            turn: expect.objectContaining({
              id: 'mock-turn-1',
            }),
          }),
        }),
        expect.objectContaining({
          method: 'item/started',
          params: expect.objectContaining({
            threadId: 'thread-123',
            item: expect.objectContaining({
              type: 'webSearch',
              query: 'coral test',
            }),
          }),
        }),
        expect.objectContaining({
          method: 'item/completed',
          params: expect.objectContaining({
            threadId: 'thread-123',
            item: expect.objectContaining({
              type: 'agentMessage',
              text: 'final response',
              phase: 'final_answer',
            }),
          }),
        }),
        expect.objectContaining({
          method: 'turn/completed',
          params: expect.objectContaining({
            threadId: 'thread-123',
            turn: expect.objectContaining({
              id: 'mock-turn-1',
              status: 'completed',
            }),
          }),
        }),
      ]),
    );

    unsubscribe();
    handle.markExpectedClose();
    const shutdownPromise = handle.rpc.request('thread/shutdown', {});
    await advance(runtime, 1);
    await expect(shutdownPromise).resolves.toEqual({});
    await expect(handle.closePromise).resolves.toBeUndefined();
  });

  it('records spawn IO and replays it as spawn and durable simulation scripts', async () => {
    const recordingDir = createTempDir('coral-sim-recording-');
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({
      stdout: [
        { delayMs: 1, data: 'alpha\n' },
        { delayMs: 2, data: 'beta\n' },
      ],
      stderr: [{ delayMs: 3, data: 'warn\n' }],
      close: { delayMs: 4, code: 0 },
    });

    const child = runtime.process.spawn({
      command: 'mock-provider',
      args: ['--exec'],
      envAdditions: {
        TOKEN: 'redacted',
      },
      mode: 'piped',
    });
    const closePromise = waitForChildClose(child);
    const recording = recordSpawn(child);
    child.stdin?.write('request-one\n');

    await advance(runtime, 4);
    await expect(closePromise).resolves.toEqual({ code: 0, signal: null });

    expect(recording.command).toBe('mock-provider');
    expect(recording.args).toEqual(['--exec']);
    expect(recording.env).toEqual({ TOKEN: 'redacted' });
    expect(recording.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'stdin', data: 'request-one\n' }),
        expect.objectContaining({ type: 'stdout', data: 'alpha\n' }),
        expect.objectContaining({ type: 'stdout', data: 'beta\n' }),
        expect.objectContaining({ type: 'stderr', data: 'warn\n' }),
        expect.objectContaining({ type: 'close', code: 0, signal: null }),
      ]),
    );

    const filePath = join(recordingDir, 'spawn.json');
    saveRecording(runtime.storage, recording, filePath);
    const loaded = loadRecording(runtime.storage, filePath);
    expect(loaded).toEqual(recording);

    const replayRuntime = new SimulationRuntime();
    replayRuntime.spawner.enqueueSpawn(recordingToSpawnScript(loaded));
    const replayChild = replayRuntime.process.spawn({
      command: 'replay-provider',
      args: [],
      mode: 'piped',
    });
    const replayClosePromise = waitForChildClose(replayChild);
    let replayStdout = '';
    let replayStderr = '';
    replayChild.stdout?.setEncoding('utf8').on('data', (chunk: string | Buffer) => {
      replayStdout += chunk.toString();
    });
    replayChild.stderr?.setEncoding('utf8').on('data', (chunk: string | Buffer) => {
      replayStderr += chunk.toString();
    });

    await advance(replayRuntime, 4);
    await expect(replayClosePromise).resolves.toEqual({ code: 0, signal: null });
    expect(replayStdout).toBe('alpha\nbeta\n');
    expect(replayStderr).toBe('warn\n');

    const durableRuntime = new SimulationRuntime();
    durableRuntime.spawner.enqueueDurable(recordingToDurableScript(loaded));
    const durable = await durableRuntime.process.durable.launch({
      provider: 'mock-provider',
      command: 'mock-provider',
      args: ['--exec'],
      jobDir: '/tmp/sim/jobs/recording-roundtrip',
    });
    const exitPromise = durableRuntime.process.durable.waitForExit(durable);

    await advance(durableRuntime, 4);
    await expect(exitPromise).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
    });
    expect(durableRuntime.storage.readFileSync(durable.stdoutPath, 'utf-8')).toBe('alpha\nbeta\n');
    expect(durableRuntime.storage.readFileSync(durable.stderrPath, 'utf-8')).toBe('warn\n');
  });
});
