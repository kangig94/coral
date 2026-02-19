import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter, Readable, Writable } from 'node:stream';

// Mock dependencies
vi.mock('../cli-detection.js', () => ({
  detectCodexCli: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { detectCodexCli } from '../cli-detection.js';
import { spawn } from 'node:child_process';
import { executeOneShot, executeResume, executeFork, killAllChildren, Semaphore, _test } from '../codex-executor.js';

const mockDetect = vi.mocked(detectCodexCli);
const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  mockDetect.mockReset();
  mockSpawn.mockReset();
  _test.lastStartTime = 0;
  _test.resetShutdown();
});

function mockCliAvailable(): void {
  mockDetect.mockResolvedValue({ available: true, version: '1.0.0' });
}

function jsonl(...lines: string[]): string {
  return lines.join('\n');
}

function createMockProcess(stdout: string, code: number): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });
  const stdinStream = new Writable({
    write(_chunk, _enc, cb) { cb(); },
  });

  Object.assign(proc, {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: stdinStream,
    kill: vi.fn(),
    pid: 12345,
  });

  setTimeout(() => {
    stdoutStream.push(stdout);
    stdoutStream.push(null);
    proc.emit('close', code);
  }, 10);

  return proc;
}

describe('executeOneShot', () => {
  it('spawns codex with correct args', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"thread.started","thread_id":"t-123"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeOneShot('test prompt', 'o4-mini', '/tmp');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', '--json', '--full-auto'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
    expect(result.response).toBe('Hello');
    expect(result.threadId).toBe('t-123');
    expect(result.model).toBe('o4-mini');
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('throws when CLI is not available', async () => {
    mockDetect.mockResolvedValue({ available: false, error: 'Codex CLI not found.' });

    await expect(executeOneShot('test')).rejects.toThrow('Codex CLI not found.');
  });

  it('throws on non-zero exit with no stdout', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess('', 1));

    await expect(executeOneShot('test')).rejects.toThrow('Codex exited with code 1');
  });

  it('returns exitCode when non-zero with stdout', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"error","message":"Rate limit"}',
      '{"type":"turn.failed","error":{"message":"Rate limit"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 1));

    const result = await executeOneShot('test');
    expect(result.exitCode).toBe(1);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Rate limit']);
  });

  it('uses default model when none provided', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeOneShot('test');
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('executeResume', () => {
  const agentOk = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';

  it('passes correct resume args', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Resumed"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeResume('thread-abc', 'continue', 'gpt-4.1');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', 'thread-abc', '-m', 'gpt-4.1', '--json', '--full-auto'],
      expect.any(Object),
    );
    expect(result.response).toBe('Resumed');
    expect(result.threadId).toBe('thread-abc');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('passes working_directory as cwd to spawn', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume('thread-abc', 'review', undefined, '/home/user/project');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', 'resume', 'thread-abc']),
      expect.objectContaining({ cwd: '/home/user/project' }),
    );
  });

  it('omits cwd when working_directory not provided', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume('thread-abc', 'review');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.not.objectContaining({ cwd: expect.anything() }),
    );
  });
});

describe('executeFork', () => {
  it('delegates to resume with default prompt', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"thread.started","thread_id":"t-fork"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Forked"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeFork('thread-orig');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', 'resume', 'thread-orig']),
      expect.any(Object),
    );
    expect(result.response).toBe('Forked');
    expect(result.threadId).toBe('t-fork');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('passes custom prompt to resume', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Custom"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await executeFork('t1', 'Do something new', 'o4-mini');

    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe('killAllChildren', () => {
  it('clears tracked processes after kill', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await executeOneShot('test');
    killAllChildren();

    const proc2 = createMockProcess(output, 0);
    const killSpy = vi.fn();
    (proc2 as any).kill = killSpy;
    mockSpawn.mockReturnValue(proc2);

    killAllChildren();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('Semaphore', () => {
  it('allows up to max concurrent acquires', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);
    expect(sem.pending).toBe(0);
  });

  it('queues excess acquires', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    // Second acquire should be pending
    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });
    expect(sem.pending).toBe(1);
    expect(resolved).toBe(false);
    sem.release();
    await p;
    expect(resolved).toBe(true);
    expect(sem.active).toBe(1);
  });

  it('releases in FIFO order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    sem.release();
    await p1;
    sem.release();
    await p2;
    expect(order).toEqual([1, 2]);
    sem.release(); // cleanup
  });
});

describe('stagger', () => {
  const agentOk = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';

  it('delays execution when called within STAGGER_MS of last start', async () => {
    mockCliAvailable();
    // Defer process creation so its 10ms data timer does not fire during the stagger sleep
    mockSpawn.mockImplementation(() => createMockProcess(agentOk, 0) as any);

    _test.lastStartTime = Date.now();
    const start = Date.now();
    await executeOneShot('test');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(2500);
  }, 10_000);

  it('skips delay when enough time has passed since last start', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    _test.lastStartTime = Date.now() - 10_000;
    const start = Date.now();
    await executeOneShot('test');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});

describe('shutdown guard', () => {
  it('rejects new requests after killAllChildren', async () => {
    mockCliAvailable();
    killAllChildren();
    await expect(executeOneShot('test')).rejects.toThrow('Server is shutting down');
  });
});
