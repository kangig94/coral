import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime, type ChildProcessLike } from '../runtime.js';

const createdDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
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

describe('createRealRuntime', () => {
  it('captures a sealed CORAL_* snapshot once', () => {
    vi.stubEnv('CORAL_OWNER', 'owner-a');
    vi.stubEnv('CORAL_EFFORT', 'high');

    const runtime = createRealRuntime();
    const snapshot = runtime.env.coralSnapshot();

    expect(snapshot).toMatchObject({
      CORAL_OWNER: 'owner-a',
      CORAL_EFFORT: 'high',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);

    vi.stubEnv('CORAL_OWNER', 'owner-b');

    expect(runtime.env.coralSnapshot().CORAL_OWNER).toBe('owner-a');
    expect(runtime.env.get('CORAL_OWNER')).toBe('owner-a');
  });

  it('spawns piped children with sanitized inherited env and per-spawn CORAL overrides', async () => {
    vi.stubEnv('KEEP_ME', 'base-value');
    vi.stubEnv('CORAL_TEST_STRIP_ME', 'secret');

    const runtime = createRealRuntime();
    const child = runtime.process.spawn({
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdout.write(JSON.stringify({',
          '  keep: process.env.KEEP_ME ?? null,',
          '  stripped: process.env.CORAL_TEST_STRIP_ME ?? null,',
          '  owner: process.env.CORAL_OWNER ?? null,',
          '  extra: process.env.EXTRA_ENV ?? null,',
          '  child: process.env.CORAL_CHILD ?? null,',
          '}));',
        ].join(''),
      ],
      envAdditions: {
        CORAL_OWNER: 'session-123',
        EXTRA_ENV: 'extra-value',
      },
      mode: 'piped',
    });

    const result = await readPipedOutput(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      keep: 'base-value',
      stripped: null,
      owner: 'session-123',
      extra: 'extra-value',
      child: '1',
    });
  });

  it('models ignored stdio launches explicitly', async () => {
    const runtime = createRealRuntime();
    const child = runtime.process.spawn({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      mode: 'ignored',
    });

    expect(child.stdin).toBeNull();
    expect(child.stdout).toBeNull();
    expect(child.stderr).toBeNull();

    await expect(waitForClose(child)).resolves.toEqual({ code: 0, signal: null });
  });

  it('launches durable detached jobs and materializes runtime/exit artifacts', async () => {
    const runtime = createRealRuntime();
    const rootDir = createTempDir('coral-runtime-');
    const jobDir = join(rootDir, 'job-1');
    runtime.storage.mkdirSync(jobDir, { recursive: true });

    const durable = await runtime.process.durable.launch({
      provider: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          "process.stdout.write('step-one\\n');",
          "process.stderr.write('warn\\n');",
          'setTimeout(() => process.exit(0), 25);',
        ].join(''),
      ],
      jobDir,
      envAdditions: {
        CORAL_OWNER: 'durable-owner',
      },
    });
    const exit = await runtime.process.durable.waitForExit(durable);

    expect(durable.pid).toBeGreaterThan(0);
    expect(exit).toMatchObject({ exitCode: 0, signal: null });
    expect(existsSync(join(jobDir, 'runtime.json'))).toBe(true);
    expect(existsSync(join(jobDir, 'exit.json'))).toBe(true);
    expect(runtime.storage.readFileSync(durable.stdoutPath, 'utf-8')).toContain('step-one');
    expect(runtime.storage.readFileSync(durable.stderrPath, 'utf-8')).toContain('warn');
  });
});
