import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter, Readable, Writable } from 'node:stream';

vi.mock('../cli-detection.js', () => ({
  detectCodexCli: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { detectCodexCli } from '../cli-detection.js';
import { spawn } from 'node:child_process';
import { executeOneShot, executeResume, executeFork, killAllChildren, _test } from '../codex-executor.js';

const mockDetect = vi.mocked(detectCodexCli);
const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  mockDetect.mockReset();
  mockSpawn.mockReset();
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

describe('prependClaudeMd', () => {
  afterEach(() => { _test.claudeMdCache = undefined; });

  it('prepends CLAUDE.md content to prompt', () => {
    _test.claudeMdCache = '# Guidelines\nBe concise.';
    expect(_test.prependClaudeMd('do something')).toBe('# Guidelines\nBe concise.\n\n---\n\ndo something');
  });

  it('returns prompt unchanged when CLAUDE.md is empty', () => {
    _test.claudeMdCache = '';
    expect(_test.prependClaudeMd('do something')).toBe('do something');
  });
});

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
