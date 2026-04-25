import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ChildProcessLike } from '#src/runtime/ports.js';

const createdDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

    const runtime = createRealRuntime('prod');
    const fullSnapshot = runtime.env.fullSnapshot();
    const snapshot = runtime.env.coralSnapshot();

    expect(fullSnapshot.CORAL_OWNER).toBe('owner-a');
    expect(Object.isFrozen(fullSnapshot)).toBe(true);
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

    const runtime = createRealRuntime('prod');
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

  it('does not auto-record spawned children when CORAL_SIMULATE_RECORD is enabled', async () => {
    const recordingRoot = createTempDir('coral-runtime-recordings-');
    const recordingDir = join(recordingRoot, 'recordings');
    vi.stubEnv('CORAL_SIMULATE_RECORD', recordingDir);

    const runtime = createRealRuntime('prod');
    const child = runtime.process.spawn({
      command: process.execPath,
      args: ['-e', "process.stdout.write('recorded\\n');"],
      mode: 'piped',
    });

    const result = await readPipedOutput(child);
    expect(result).toMatchObject({
      stdout: 'recorded\n',
      stderr: '',
      code: 0,
      signal: null,
    });
    expect(existsSync(recordingDir)).toBe(false);
  });

  it('models ignored stdio launches explicitly', async () => {
    const runtime = createRealRuntime('prod');
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

  it('launches durable detached jobs without materializing runtime/exit sidecar files', async () => {
    const runtime = createRealRuntime('prod');
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
    expect(existsSync(join(jobDir, 'runtime.json'))).toBe(false);
    expect(existsSync(join(jobDir, 'exit.json'))).toBe(false);
    expect(runtime.storage.readFileSync(durable.stdoutPath, 'utf-8')).toContain('step-one');
    expect(runtime.storage.readFileSync(durable.stderrPath, 'utf-8')).toContain('warn');
  });

  it('writes and appends through durable storage operations', () => {
    const runtime = createRealRuntime('prod');
    const rootDir = createTempDir('coral-runtime-durable-');
    const statePath = join(rootDir, 'nested', 'state.json');
    const logPath = join(rootDir, 'events', 'events.jsonl');

    expect(runtime.storage.writeAtomicDurableSync(statePath, '{"ok":true}', { encoding: 'utf-8', mode: 0o600 })).toBe(
      true,
    );
    expect(runtime.storage.readFileSync(statePath, 'utf-8')).toBe('{"ok":true}');

    expect(runtime.storage.appendFileDurableSync(logPath, 'one\n')).toBe(true);
    expect(runtime.storage.appendFileDurableSync(logPath, 'two\n')).toBe(true);
    expect(runtime.storage.readFileSync(logPath, 'utf-8')).toBe('one\ntwo\n');
  });

  it('returns false when durable atomic writes hit an ENOENT directory race', async () => {
    const rootDir = createTempDir('coral-runtime-durable-race-');
    const statePath = join(rootDir, 'nested', 'state.json');
    const openSyncMock = vi.fn<typeof NodeFs.openSync>(() => {
      const error = new Error('directory raced with durable open') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        openSync: openSyncMock,
      };
    });

    try {
      const { createRealRuntime: createMockedRuntime } = await import('#src/runtime/real.js');
      const runtime = createMockedRuntime();

      expect(runtime.storage.writeAtomicDurableSync(statePath, '{}')).toBe(false);
      expect(openSyncMock).toHaveBeenCalledWith(`${statePath}.tmp`, 'w');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('returns false when durable appends hit an ENOENT directory race', async () => {
    const rootDir = createTempDir('coral-runtime-durable-append-race-');
    const logPath = join(rootDir, 'nested', 'events.jsonl');
    const openSyncMock = vi.fn<typeof NodeFs.openSync>(() => {
      const error = new Error('directory raced with durable append') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        openSync: openSyncMock,
      };
    });

    try {
      const { createRealRuntime: createMockedRuntime } = await import('#src/runtime/real.js');
      const runtime = createMockedRuntime();

      expect(runtime.storage.appendFileDurableSync(logPath, 'event\n')).toBe(false);
      expect(openSyncMock).toHaveBeenCalledWith(logPath, 'a');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('best-effort fsyncs the parent directory after a durable atomic rename', async () => {
    const statePath = '/tmp/coral-runtime-parent-sync/state.json';
    const tempFd = 41;
    const parentFd = 42;
    const openSyncMock = vi.fn<typeof NodeFs.openSync>((path, flags) => {
      if (path === `${statePath}.tmp` && flags === 'w') {
        return tempFd;
      }
      if (path === '/tmp/coral-runtime-parent-sync' && flags === 'r') {
        return parentFd;
      }
      throw new Error(`unexpected openSync(${String(path)}, ${String(flags)})`);
    });
    const writeSyncMock = vi.fn((...args: unknown[]): number => {
      const buffer = args[1];
      const length = args[3];
      if (typeof length === 'number') {
        return length;
      }
      if (typeof buffer === 'string') {
        return Buffer.byteLength(buffer);
      }
      if (ArrayBuffer.isView(buffer)) {
        return buffer.byteLength;
      }
      return 0;
    });
    const fdatasyncSyncMock = vi.fn<typeof NodeFs.fdatasyncSync>();
    const fsyncSyncMock = vi.fn<typeof NodeFs.fsyncSync>();
    const closeSyncMock = vi.fn<typeof NodeFs.closeSync>();
    const renameSyncMock = vi.fn<typeof NodeFs.renameSync>();

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        closeSync: closeSyncMock,
        fdatasyncSync: fdatasyncSyncMock,
        fsyncSync: fsyncSyncMock,
        openSync: openSyncMock,
        renameSync: renameSyncMock,
        writeSync: writeSyncMock,
      };
    });

    try {
      const { createRealRuntime: createMockedRuntime } = await import('#src/runtime/real.js');
      const runtime = createMockedRuntime();

      expect(runtime.storage.writeAtomicDurableSync(statePath, '{"ok":true}')).toBe(true);
      expect(fdatasyncSyncMock).toHaveBeenCalledWith(tempFd);
      expect(renameSyncMock).toHaveBeenCalledWith(`${statePath}.tmp`, statePath);
      expect(openSyncMock).toHaveBeenCalledWith('/tmp/coral-runtime-parent-sync', 'r');
      expect(fsyncSyncMock).toHaveBeenCalledWith(parentFd);
      expect(closeSyncMock).toHaveBeenCalledWith(tempFd);
      expect(closeSyncMock).toHaveBeenCalledWith(parentFd);
      expect(renameSyncMock.mock.invocationCallOrder[0]).toBeLessThan(openSyncMock.mock.invocationCallOrder[1]);
      expect(openSyncMock.mock.invocationCallOrder[1]).toBeLessThan(fsyncSyncMock.mock.invocationCallOrder[0]);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
