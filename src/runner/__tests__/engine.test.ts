import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter, Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import {
  spawnCli,
  activeChildren,
  killAllChildren,
  CliBusyError,
  MAX_ACTIVE_CHILDREN,
  MAX_ACTIVE_CHILDREN_PER_PROVIDER,
} from '../engine.js';

const mockSpawn = vi.mocked(spawn);

function createMockProcess(opts?: {
  stdout?: string;
  stderr?: string;
  closeCode?: number;
  autoClose?: boolean;
}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });
  const stdinStream = new Writable({
    write(_chunk, _enc, cb) { cb(); },
  });
  const kill = vi.fn();

  Object.assign(proc, {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: stdinStream,
    kill,
    pid: 1234,
  });

  const autoClose = opts?.autoClose ?? true;
  if (autoClose) {
    setTimeout(() => {
      if (opts?.stdout) stdoutStream.push(opts.stdout);
      if (opts?.stderr) stderrStream.push(opts.stderr);
      stdoutStream.push(null);
      stderrStream.push(null);
      proc.emit('close', opts?.closeCode ?? 0);
    }, 5);
  }

  return proc;
}

describe('runner engine spawnCli', () => {
  beforeEach(() => {
    activeChildren.clear();
    mockSpawn.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    activeChildren.clear();
    vi.useRealTimers();
  });

  it('spawns command, writes stdin prompt, and returns output', async () => {
    const proc = createMockProcess({
      stdout: 'line-1\nline-2\n',
      closeCode: 0,
    });
    mockSpawn.mockReturnValue(proc);
    const onEvent = vi.fn();

    const result = await spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
      prompt: 'hello',
      cwd: '/tmp/work',
      onEvent,
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--output-format', 'json'],
      expect.objectContaining({ cwd: '/tmp/work' }),
    );
    expect(result).toMatchObject({ stdout: 'line-1\nline-2\n', code: 0, aborted: false });
    expect(onEvent).toHaveBeenCalledWith('line-1');
    expect(onEvent).toHaveBeenCalledWith('line-2');
  });

  it('enforces global active child cap with structured busy error', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN; i += 1) {
      activeChildren.add({ provider: 'codex', child: createMockProcess({ autoClose: false }) });
    }

    await expect(spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p'],
      prompt: 'x',
    })).rejects.toBeInstanceOf(CliBusyError);

    try {
      await spawnCli({ provider: 'claude', command: 'claude', args: ['-p'], prompt: 'x' });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CliBusyError);
      const busy = error as CliBusyError;
      expect(busy.detail.globalLimit).toBe(MAX_ACTIVE_CHILDREN);
      expect(busy.detail.globalActive).toBe(MAX_ACTIVE_CHILDREN);
    }
  });

  it('enforces per-provider cap with structured busy error', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN_PER_PROVIDER; i += 1) {
      activeChildren.add({ provider: 'claude', child: createMockProcess({ autoClose: false }) });
    }

    await expect(spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p'],
      prompt: 'x',
    })).rejects.toBeInstanceOf(CliBusyError);
  });

  it('kills all tracked children via graceful lifecycle', () => {
    const childA = createMockProcess({ autoClose: false });
    const childB = createMockProcess({ autoClose: false });
    activeChildren.add({ provider: 'codex', child: childA });
    activeChildren.add({ provider: 'claude', child: childB });

    killAllChildren();

    expect((childA.kill as any)).toHaveBeenCalledWith('SIGTERM');
    expect((childB.kill as any)).toHaveBeenCalledWith('SIGTERM');
    expect(activeChildren.size).toBe(0);
  });

  it('aborts idle processes after timeout', async () => {
    vi.useFakeTimers();
    const proc = createMockProcess({ autoClose: false });
    mockSpawn.mockReturnValue(proc);

    const promise = spawnCli({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      prompt: 'x',
    });

    // Attach rejection handler before advancing timers to avoid unhandled rejection
    const assertion = expect(promise).rejects.toThrow('killed after 10 minutes of inactivity');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

    await assertion;
  });
});

describe('runner engine cap boundary and cross-provider accounting', () => {
  beforeEach(() => {
    activeChildren.clear();
    mockSpawn.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    activeChildren.clear();
    vi.useRealTimers();
  });

  it('does not block a claude spawn when only codex fills per-provider cap', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN_PER_PROVIDER; i += 1) {
      activeChildren.add({ provider: 'codex', child: createMockProcess({ autoClose: false }) });
    }

    const proc = createMockProcess({ stdout: 'ok', closeCode: 0 });
    mockSpawn.mockReturnValue(proc);

    const result = await spawnCli({ provider: 'claude', command: 'claude', args: ['-p'], prompt: 'x' });
    expect(result.stdout).toBe('ok');
  });

  it('does not block a codex spawn when only claude fills per-provider cap', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN_PER_PROVIDER; i += 1) {
      activeChildren.add({ provider: 'claude', child: createMockProcess({ autoClose: false }) });
    }

    const proc = createMockProcess({ stdout: 'ok', closeCode: 0 });
    mockSpawn.mockReturnValue(proc);

    const result = await spawnCli({ provider: 'codex', command: 'codex', args: ['exec'], prompt: 'y' });
    expect(result.stdout).toBe('ok');
  });

  it('CliBusyError.detail.providerActive counts only the requesting provider', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN_PER_PROVIDER; i += 1) {
      activeChildren.add({ provider: 'codex', child: createMockProcess({ autoClose: false }) });
    }
    // Claude children must not inflate the codex count.
    activeChildren.add({ provider: 'claude', child: createMockProcess({ autoClose: false }) });
    activeChildren.add({ provider: 'claude', child: createMockProcess({ autoClose: false }) });

    try {
      await spawnCli({ provider: 'codex', command: 'codex', args: ['exec'], prompt: 'x' });
      expect.fail('should have thrown CliBusyError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(CliBusyError);
      const busy = err as CliBusyError;
      expect(busy.detail.providerActive).toBe(MAX_ACTIVE_CHILDREN_PER_PROVIDER);
      expect(busy.detail.provider).toBe('codex');
      expect(busy.detail.globalActive).toBe(MAX_ACTIVE_CHILDREN_PER_PROVIDER + 2);
    }
  });

  it('allows spawn at MAX-1 active children (off-by-one: >= not >)', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN - 1; i += 1) {
      activeChildren.add({ provider: 'codex', child: createMockProcess({ autoClose: false }) });
    }

    const proc = createMockProcess({ stdout: 'allowed', closeCode: 0 });
    mockSpawn.mockReturnValue(proc);

    const result = await spawnCli({ provider: 'claude', command: 'claude', args: ['-p'], prompt: 'x' });
    expect(result.stdout).toBe('allowed');
  });

  it('rejects spawn at exactly MAX active children (>= boundary)', async () => {
    for (let i = 0; i < MAX_ACTIVE_CHILDREN; i += 1) {
      activeChildren.add({ provider: 'codex', child: createMockProcess({ autoClose: false }) });
    }

    await expect(
      spawnCli({ provider: 'claude', command: 'claude', args: ['-p'], prompt: 'x' }),
    ).rejects.toBeInstanceOf(CliBusyError);
  });

  it('resolves with aborted:true when AbortSignal fires before process closes', async () => {
    const proc = createMockProcess({ autoClose: false });
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const promise = spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p'],
      prompt: 'x',
      signal: controller.signal,
    });

    controller.abort();
    setTimeout(() => {
      (proc.stdout as Readable).push(null);
      (proc.stderr as Readable).push(null);
      proc.emit('close', 1);
    }, 20);

    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it('resolves with aborted:true when AbortSignal is already aborted at call time', async () => {
    const proc = createMockProcess({ closeCode: 1 });
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    controller.abort();

    const promise = spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p'],
      prompt: 'x',
      signal: controller.signal,
    });

    setTimeout(() => {
      (proc.stdout as Readable).push(null);
      (proc.stderr as Readable).push(null);
      proc.emit('close', 1);
    }, 20);

    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it('rejects with spawn error message when process emits error event', async () => {
    const proc = createMockProcess({ autoClose: false });
    mockSpawn.mockReturnValue(proc);

    const promise = spawnCli({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      prompt: 'x',
    });

    setTimeout(() => proc.emit('error', new Error('ENOENT: no such file')), 5);

    await expect(promise).rejects.toThrow('ENOENT: no such file');
  });

  it('does not emit partial line as event until newline arrives', async () => {
    const proc = createMockProcess({ autoClose: false });
    mockSpawn.mockReturnValue(proc);

    const events: string[] = [];
    const promise = spawnCli({
      provider: 'claude',
      command: 'claude',
      args: ['-p'],
      prompt: 'x',
      onEvent: (line) => events.push(line),
    });

    setTimeout(() => (proc.stdout as Readable).push('partial'), 5);
    setTimeout(() => {
      (proc.stdout as Readable).push('-line\nsecond-line\n');
      (proc.stdout as Readable).push(null);
      (proc.stderr as Readable).push(null);
      proc.emit('close', 0);
    }, 15);

    await promise;
    expect(events).toContain('partial-line');
    expect(events).toContain('second-line');
  });

  it('removes entry from activeChildren after process closes normally', async () => {
    const proc = createMockProcess({ stdout: 'done', closeCode: 0 });
    mockSpawn.mockReturnValue(proc);

    expect(activeChildren.size).toBe(0);
    await spawnCli({ provider: 'claude', command: 'claude', args: ['-p'], prompt: 'x' });
    expect(activeChildren.size).toBe(0);
  });
});
