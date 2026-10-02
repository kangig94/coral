import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { loadRecording } from '#src/infra/spawn-recording.js';
import {
  EventEmitterObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
} from '#src/coordinator/spawn-observer.js';

function waitForClose(child: ChildProcessLike): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });
}

async function readPipedOutput(child: ChildProcessLike): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (!child.stdout || !child.stderr) {
    throw new Error('Expected piped stdio handles');
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string | Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: string | Buffer) => {
    stderr += chunk.toString();
  });

  const result = await waitForClose(child);
  return { stdout, stderr, ...result };
}

describe('recording observer', () => {
  it('records spawned children through the observer subscriber wiring', async () => {
    const runtime = new SimulationRuntime();
    const observer = new EventEmitterObserver();
    observeRuntimeSpawns(runtime, observer);

    const recordingDir = '/recordings';
    runtime.storage.mkdirSync(recordingDir, { recursive: true });
    attachRecordingObserver({
      observer,
      runtime,
      recordingDir,
    });

    runtime.spawner.enqueueSpawn({
      stdout: [{ delayMs: 1, data: 'recorded\n' }],
      close: { delayMs: 1, code: 0 },
    });
    const child = runtime.process.spawn({ command: 'recorded-child', args: [] });
    const pending = readPipedOutput(child);
    await flushMicrotasks();
    runtime.time.tick(1);
    const result = await pending;
    expect(result).toEqual({
      stdout: 'recorded\n',
      stderr: '',
      code: 0,
      signal: null,
    });

    const files = runtime.storage.readdirSync(recordingDir);
    expect(files).toHaveLength(1);

    const recording = loadRecording(runtime.storage, join(recordingDir, files[0]));
    expect(recording.command).toBe('recorded-child');
    expect(recording.args).toEqual([]);
    expect(recording.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'stdout', data: 'recorded\n' }),
        expect.objectContaining({ type: 'close', code: 0, signal: null }),
      ]),
    );
  });

  it.each([
    {
      name: 'simulation',
      createRuntime: () => new SimulationRuntime(),
      command: 'fake-late-bound',
      args: ['--simulation'],
      runExec: async (runtime: SimulationRuntime) => {
        runtime.spawner.enqueueSpawn({
          stdout: [{ delayMs: 1, data: 'late-bound\n' }],
          close: { delayMs: 1, code: 0 },
        });
        const execPromise = runtime.process.exec('fake-late-bound', ['--simulation']);
        await flushMicrotasks();
        runtime.time.tick(1);
        await flushMicrotasks();
        return execPromise;
      },
    },
  ])('observes late-bound exec dispatch after wrapping spawn post-construction (%s)', async (scenario) => {
    const runtime = scenario.createRuntime();
    const observer = new EventEmitterObserver();
    const events: Array<{ command: string; args: string[] }> = [];

    observer.onSpawn((event) => {
      events.push({
        command: event.command,
        args: [...event.args],
      });
    });
    observeRuntimeSpawns(runtime, observer);

    await expect(scenario.runExec(runtime as never)).resolves.toEqual({
      stdout: 'late-bound\n',
      stderr: '',
      status: 0,
    });
    expect(events).toEqual([
      {
        command: scenario.command,
        args: scenario.args,
      },
    ]);
  });
});
