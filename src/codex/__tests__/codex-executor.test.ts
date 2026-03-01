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
  mockDetect.mockResolvedValue({ available: true, version: '1.0.0', authState: 'authenticated' as const });
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
      ['exec', '-m', 'o4-mini', '--json', '--skip-git-repo-check', '--full-auto', '-c', 'web_search=live', '-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
    expect(result.response).toBe('Hello');
    expect(result.sessionId).toBe('t-123');
    expect(result.model).toBe('o4-mini');
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('throws when CLI is not available', async () => {
    mockDetect.mockResolvedValue({ available: false, error: 'Codex CLI not found.' });

    await expect(executeOneShot('test')).rejects.toThrow('Codex CLI not found.');
  });

  it('throws when CLI is unauthenticated', async () => {
    mockDetect.mockResolvedValue({
      available: true,
      version: '1.0.0',
      authState: 'unauthenticated',
      authError: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
    });

    await expect(executeOneShot('test')).rejects.toThrow('Codex CLI is not authenticated');
    expect(mockSpawn).not.toHaveBeenCalled();
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

  it('appends -c model_reasoning_effort when set', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await executeOneShot('test', 'o4-mini', '/tmp', 'xhigh');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', '--json', '--skip-git-repo-check', '--full-auto', '-c', 'web_search=live', '-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'model_reasoning_effort=xhigh'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('uses default model when none provided', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeOneShot('test');
    expect(result.model).toBe(process.env.CORAL_CODEX_MODEL ?? 'gpt-5.3-codex');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('uses --dangerously-bypass-approvals-and-sandbox when bypassSandbox=true', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await executeOneShot('test', 'o4-mini', '/tmp', undefined, true);

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'web_search=live'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('uses --full-auto when bypassSandbox=false (default)', async () => {
    mockCliAvailable();
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await executeOneShot('test', 'o4-mini', '/tmp', undefined, false);

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', '--json', '--skip-git-repo-check', '--full-auto', '-c', 'web_search=live', '-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('skips detectCodexCli when preChecked is provided', async () => {
    const output = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await executeOneShot(
      'test',
      'o4-mini',
      '/tmp',
      undefined,
      false,
      undefined,
      undefined,
      { available: true, version: '1.0.0', authState: 'authenticated' },
    );

    expect(mockDetect).not.toHaveBeenCalled();
  });
});

describe('executeResume', () => {
  const agentOk = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';

  it('passes correct resume args', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"thread.started","thread_id":"thread-abc"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Resumed"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeResume('thread-abc', 'continue', 'gpt-4.1');

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', 'thread-abc', '-m', 'gpt-4.1', '--json', '--skip-git-repo-check', '--full-auto', '-c', 'web_search=live', '-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
      expect.any(Object),
    );
    expect(result.response).toBe('Resumed');
    expect(result.sessionId).toBe('thread-abc');
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

  it('uses --dangerously-bypass-approvals-and-sandbox when bypassSandbox=true', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume('thread-abc', 'continue', 'gpt-4.1', undefined, undefined, true);

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', 'thread-abc', '-m', 'gpt-4.1', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'web_search=live'],
      expect.any(Object),
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
    expect(result.sessionId).toBe('t-fork');
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

describe('idle timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function createIdleProcess(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
    const proc = new EventEmitter() as ChildProcess;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    const stdinStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    Object.assign(proc, {
      stdout: stdoutStream,
      stderr: stderrStream,
      stdin: stdinStream,
      kill: vi.fn(),
      pid: 99999,
    });
    return proc as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  }

  it('kills process after 10 minutes of inactivity', async () => {
    mockCliAvailable();
    const proc = createIdleProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = executeOneShot('test');
    promise.catch(() => {}); // prevent unhandled rejection warning
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await expect(promise).rejects.toThrow('inactivity');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not kill active process producing output', async () => {
    mockCliAvailable();
    const proc = createIdleProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = executeOneShot('test');

    // Emit data every 5 minutes - should reset idle timer each time
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      (proc.stdout as Readable).push('{"type":"turn.started"}\n');
    }

    expect(proc.kill).not.toHaveBeenCalled();

    // Now let it finish
    (proc.stdout as Readable).push('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Done"}}\n');
    (proc.stdout as Readable).push(null);
    proc.emit('close', 0);

    const result = await promise;
    expect(result.response).toBe('Done');
  });

  it('error message derives duration from constant', async () => {
    mockCliAvailable();
    const proc = createIdleProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = executeOneShot('test');
    promise.catch(() => {}); // prevent unhandled rejection warning
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await expect(promise).rejects.toThrow('10 minutes of inactivity');
  });
});

/** Process that never closes on its own - caller controls close event. */
function createManualProcess() {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });
  const stdinStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  Object.assign(proc, { stdout: stdoutStream, stderr: stderrStream, stdin: stdinStream, kill: vi.fn(), pid: 42 });
  return proc as ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

describe('abort signal', () => {
  // executeOneShot awaits detectCodexCli() as a microtask before calling spawnCodex.
  // We must yield one tick (await Promise.resolve()) so that spawnCodex runs and
  // attaches its event listeners before we push data or emit close.

  it('resolves with aborted=true and preserves partial output when signal fires', async () => {
    mockCliAvailable();
    const proc = createManualProcess();
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const promise = executeOneShot('test', undefined, undefined, undefined, undefined, undefined, controller.signal);

    await Promise.resolve(); // let detectCodexCli resolve and spawnCodex attach listeners

    // emit('data') fires the listener synchronously (unlike push() which buffers)
    (proc.stdout as Readable).emit('data', Buffer.from('{"type":"thread.started","thread_id":"t-partial"}\n'));
    controller.abort();
    proc.emit('close', null);

    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.sessionId).toBe('t-partial');
  });

  it('does not throw on abort with empty stdout', async () => {
    mockCliAvailable();
    const proc = createManualProcess();
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const promise = executeOneShot('test', undefined, undefined, undefined, undefined, undefined, controller.signal);

    await Promise.resolve();
    controller.abort();
    proc.emit('close', 1); // non-zero exit, no stdout - normally would throw

    await expect(promise).resolves.toMatchObject({ aborted: true });
  });

  it('is a no-op when abort fires after natural completion', async () => {
    mockCliAvailable();
    const proc = createManualProcess();
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const promise = executeOneShot('test', undefined, undefined, undefined, undefined, undefined, controller.signal);

    await Promise.resolve();
    (proc.stdout as Readable).emit('data', Buffer.from('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Done"}}\n'));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.aborted).toBe(false);
    expect(result.response).toBe('Done');
    expect(() => controller.abort()).not.toThrow();
  });

  describe('with fake timers', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('clears idle timer on abort (no rejection race)', async () => {
      mockCliAvailable();
      const proc = createManualProcess();
      mockSpawn.mockReturnValue(proc);

      const controller = new AbortController();
      const promise = executeOneShot('test', undefined, undefined, undefined, undefined, undefined, controller.signal);

      await vi.advanceTimersByTimeAsync(0); // flush microtasks so spawnCodex attaches listeners

      controller.abort();
      proc.emit('close', null);

      // Advance past idle timeout - should NOT reject since timer was cleared on abort
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      await expect(promise).resolves.toMatchObject({ aborted: true });
    });
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
    (proc2 as ChildProcess & { kill: ReturnType<typeof vi.fn> }).kill = killSpy;
    mockSpawn.mockReturnValue(proc2);

    killAllChildren();
    expect(killSpy).not.toHaveBeenCalled();
  });
});
