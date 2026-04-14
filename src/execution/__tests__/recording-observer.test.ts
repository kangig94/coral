import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EventEmitterObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
} from '../recording-observer.js';
import { createRealRuntime, type ChildProcessLike } from '../runtime.js';
import { loadRecording } from '../simulation/recording.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('recording observer', () => {
  it('records spawned children through the observer subscriber wiring', async () => {
    const runtime = createRealRuntime();
    const observer = new EventEmitterObserver();
    observeRuntimeSpawns(runtime, observer);

    const recordingDir = createTempDir('coral-recording-observer-');
    attachRecordingObserver({
      observer,
      runtime,
      recordingDir,
    });

    const child = runtime.process.spawn({
      command: process.execPath,
      args: ['-e', "process.stdout.write('recorded\\n');"],
      mode: 'piped',
    });

    const result = await readPipedOutput(child);
    expect(result).toEqual({
      stdout: 'recorded\n',
      stderr: '',
      code: 0,
      signal: null,
    });

    const files = readdirSync(recordingDir);
    expect(files).toHaveLength(1);

    const recording = loadRecording(runtime.storage, join(recordingDir, files[0]!));
    expect(recording.command).toBe(process.execPath);
    expect(recording.args).toEqual(['-e', "process.stdout.write('recorded\\n');"]);
    expect(recording.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'stdout', data: 'recorded\n' }),
        expect.objectContaining({ type: 'close', code: 0, signal: null }),
      ]),
    );
  });
});
