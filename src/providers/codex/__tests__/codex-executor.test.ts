import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, Readable, Writable } from 'node:stream';
import type { CodexExecOptions } from '../codex-executor.js';

const mockState = vi.hoisted(() => ({
  detectCodexCli: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../cli-detection.js', () => ({
  detectCodexCli: mockState.detectCodexCli,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockState.execFileSync,
  spawn: mockState.spawn,
}));

type ExecutorModule = typeof import('../codex-executor.js');

let executeOneShot: ExecutorModule['executeOneShot'];
let executeResume: ExecutorModule['executeResume'];
let executeFork: ExecutorModule['executeFork'];
let killAllChildren: ExecutorModule['killAllChildren'];

async function loadExecutor(pluginRoot?: string): Promise<ExecutorModule> {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (pluginRoot !== undefined) {
    vi.stubGlobal('__PLUGIN_ROOT__', pluginRoot);
  }
  return import('../codex-executor.js');
}

const mockDetect = mockState.detectCodexCli;
const mockExecFileSync = mockState.execFileSync;
const mockSpawn = mockState.spawn;

beforeEach(async () => {
  mockDetect.mockReset();
  mockExecFileSync.mockReset();
  mockSpawn.mockReset();
  ({ executeOneShot, executeResume, executeFork, killAllChildren } = await loadExecutor());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function mockCliAvailable(): void {
  mockDetect.mockResolvedValue({ available: true, version: '1.0.0', authState: 'authenticated' as const });
}

const authenticatedCli = { available: true as const, version: '1.0.0', authState: 'authenticated' as const };

function withAuthenticatedCli(overrides: Partial<Omit<CodexExecOptions, 'preChecked'>> = {}): CodexExecOptions {
  return {
    environment: {},
    ...overrides,
    preChecked: authenticatedCli,
  };
}

function jsonl(...lines: string[]): string {
  return lines.join('\n');
}

function agentMessage(text = 'OK'): string {
  return `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"${text}"}}\n`;
}

function mockAgentProcess(text = 'OK', code = 0): void {
  mockSpawn.mockReturnValue(createMockProcess(agentMessage(text), code));
}

const FULL_AUTO_FLAGS = [
  '--json',
  '--skip-git-repo-check',
  '--full-auto',
  '-c',
  'web_search=live',
  '-c',
  'sandbox_mode=workspace-write',
  '-c',
  'sandbox_workspace_write.network_access=true',
];

const BYPASS_FLAGS = [
  '--json',
  '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox',
  '-c',
  'web_search=live',
];

// Mirrors resolveCodexDefaultEffort: CORAL_CODEX_EFFORT uses Codex naming (xhigh), CORAL_EFFORT uses Claude naming (max)
function expectedDefaultEffortFlag(): string {
  const codexEnv = process.env.CORAL_CODEX_EFFORT;
  if (codexEnv !== undefined) return codexEnv; // already Codex-native
  const shared = process.env.CORAL_EFFORT;
  if (shared !== undefined) return shared === 'max' ? 'xhigh' : shared;
  return 'xhigh';
}
const DEFAULT_EFFORT_FLAGS = ['-c', `model_reasoning_effort=${expectedDefaultEffortFlag()}`];

type MockProcess = ChildProcess & { stdinWrites: string[] };

function createMockProcess(stdout: string, code: number): MockProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });
  const stdinWrites: string[] = [];
  const stdinStream = new Writable({
    write(chunk, _enc, cb) {
      stdinWrites.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      cb();
    },
  });

  Object.assign(proc, {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: stdinStream,
    kill: vi.fn(),
    pid: 12345,
    stdinWrites,
  });

  setTimeout(() => {
    stdoutStream.push(stdout);
    stdoutStream.push(null);
    proc.emit('close', code);
  }, 10);
  return proc as MockProcess;
}

describe('prependInjectMd', () => {
  it('prepends INJECT.md content to prompt', async () => {
    const pluginRoot = mkdtempSync(join('/tmp', 'coral-codex-plugin-'));
    try {
      writeFileSync(join(pluginRoot, 'INJECT.md'), '# Guidelines\nBe concise.');
      const customExecutor = await loadExecutor(pluginRoot);
      const proc = createMockProcess(agentMessage(), 0);
      mockSpawn.mockReturnValue(proc);

      await customExecutor.executeOneShot('do something', withAuthenticatedCli());

      expect(proc.stdinWrites.join('')).toBe('# Guidelines\nBe concise.\n\n---\n\ndo something');
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it('replaces {{CORAL_PROJECTS}} using workingDirectory before prepending', async () => {
    const pluginRoot = mkdtempSync(join('/tmp', 'coral-codex-plugin-'));
    try {
      writeFileSync(join(pluginRoot, 'INJECT.md'), 'Memo dir: {{CORAL_PROJECTS}}/memo');
      mockExecFileSync.mockReturnValue('https://token@github.com/acme/my.repo.git\n');
      const customExecutor = await loadExecutor(pluginRoot);
      const proc = createMockProcess(agentMessage(), 0);
      mockSpawn.mockReturnValue(proc);

      await customExecutor.executeOneShot('do something', withAuthenticatedCli({ workingDirectory: '/tmp/project-root' }));

      expect(proc.stdinWrites.join('')).toBe(`Memo dir: ${join(homedir(), '.coral', 'projects', 'acme-my.repo')}/memo\n\n---\n\ndo something`);
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it('returns prompt unchanged when INJECT.md is empty', async () => {
    const pluginRoot = mkdtempSync(join('/tmp', 'coral-codex-plugin-'));
    try {
      writeFileSync(join(pluginRoot, 'INJECT.md'), '');
      const customExecutor = await loadExecutor(pluginRoot);
      const proc = createMockProcess(agentMessage(), 0);
      mockSpawn.mockReturnValue(proc);

      await customExecutor.executeOneShot('do something', withAuthenticatedCli());

      expect(proc.stdinWrites.join('')).toBe('do something');
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
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

    const result = await executeOneShot('test prompt', withAuthenticatedCli({ model: 'o4-mini', workingDirectory: '/tmp' }));

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', ...FULL_AUTO_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      expect.objectContaining({ cwd: '/tmp' }),
    );
    expect(result.response).toBe('Hello');
    expect(result.sessionId).toBe('t-123');
    expect(result.model).toBe('o4-mini');
    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('throws when preChecked is unauthenticated', async () => {
    await expect(executeOneShot('test', {
      environment: {},
      preChecked: {
        available: true,
        version: '1.0.0',
        authState: 'unauthenticated',
        authError: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
      },
    })).rejects.toThrow('Codex CLI is not authenticated');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('throws on non-zero exit with no stdout', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess('', 1));

    await expect(executeOneShot('test', withAuthenticatedCli())).rejects.toThrow('Codex exited with code 1');
  });

  it('returns exitCode when non-zero with stdout', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"error","message":"Rate limit"}',
      '{"type":"turn.failed","error":{"message":"Rate limit"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 1));

    const result = await executeOneShot('test', withAuthenticatedCli());
    expect(result.exitCode).toBe(1);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Rate limit']);
  });

  it('throws when codex exits successfully but produces no meaningful output', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"thread.started","thread_id":"t-empty"}',
      '{"type":"item.completed","item":{"id":"w1","type":"error","message":"Deprecated API usage"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await expect(executeOneShot('test', withAuthenticatedCli())).rejects.toThrow(
      'Codex produced no meaningful output (no assistant content, no errors)',
    );
  });

  it('appends -c model_reasoning_effort when effort is set', async () => {
    mockCliAvailable();
    mockAgentProcess();

    await executeOneShot('test', withAuthenticatedCli({ model: 'o4-mini', workingDirectory: '/tmp', effort: 'max' }));

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', ...FULL_AUTO_FLAGS, '-c', 'model_reasoning_effort=xhigh'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('uses default model when none provided', async () => {
    mockCliAvailable();
    mockAgentProcess();

    const result = await executeOneShot('test', withAuthenticatedCli());
    expect(result.model).toBe('gpt-5.4');
  });

  it('uses --dangerously-bypass-approvals-and-sandbox when bypassSandbox=true', async () => {
    mockCliAvailable();
    mockAgentProcess();

    await executeOneShot('test', withAuthenticatedCli({ model: 'o4-mini', workingDirectory: '/tmp', bypassSandbox: true }));

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', ...BYPASS_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('uses --full-auto when bypassSandbox=false (default)', async () => {
    mockCliAvailable();
    mockAgentProcess();

    await executeOneShot('test', withAuthenticatedCli({ model: 'o4-mini', workingDirectory: '/tmp', bypassSandbox: false }));

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '-m', 'o4-mini', ...FULL_AUTO_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('does not call detectCodexCli when preChecked is provided', async () => {
    mockAgentProcess();

    await executeOneShot(
      'test',
      withAuthenticatedCli({
        model: 'o4-mini',
        workingDirectory: '/tmp',
        bypassSandbox: false,
      }),
    );

    expect(mockDetect).not.toHaveBeenCalled();
  });
});

describe('executeResume', () => {
  const agentOk = agentMessage();

  it('passes correct resume args', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"thread.started","thread_id":"thread-abc"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Resumed"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeResume('thread-abc', 'continue', withAuthenticatedCli({ model: 'gpt-4.1' }));

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', 'thread-abc', '-m', 'gpt-4.1', ...FULL_AUTO_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      expect.any(Object),
    );
    expect(result.response).toBe('Resumed');
    expect(result.sessionId).toBe('thread-abc');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('passes work_dir as cwd to spawn', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume('thread-abc', 'review', withAuthenticatedCli({ workingDirectory: '/home/user/project' }));

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', 'resume', 'thread-abc']),
      expect.objectContaining({ cwd: '/home/user/project' }),
    );
  });

  it('omits cwd when work_dir not provided', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume('thread-abc', 'review', withAuthenticatedCli());

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.not.objectContaining({ cwd: expect.anything() }),
    );
  });

  it('uses --dangerously-bypass-approvals-and-sandbox when bypassSandbox=true', async () => {
    mockCliAvailable();
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume('thread-abc', 'continue', withAuthenticatedCli({ model: 'gpt-4.1', bypassSandbox: true }));

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', 'thread-abc', '-m', 'gpt-4.1', ...BYPASS_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      expect.any(Object),
    );
  });
});

describe('executeFork', () => {
  it('delegates to resume with the provided prompt', async () => {
    mockCliAvailable();
    const output = jsonl(
      '{"type":"thread.started","thread_id":"t-fork"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Forked"}}',
    );
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    const result = await executeFork('thread-orig', 'Continue from where we left off.', withAuthenticatedCli());

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', 'resume', 'thread-orig']),
      expect.any(Object),
    );
    expect(result.response).toBe('Forked');
    expect(result.sessionId).toBe('t-fork');
  });

  it('passes custom prompt to resume', async () => {
    mockCliAvailable();
    mockAgentProcess('Custom');

    await executeFork('t1', 'Do something new', withAuthenticatedCli({ model: 'o4-mini' }));

    expect(mockSpawn).toHaveBeenCalled();
  });
});

describe('preChecked auth guard for executeResume', () => {
  const agentOk = agentMessage();

  it('unauthenticated throws verbatim authError before spawn', async () => {
    const customError = 'Custom auth error for resume test';
    await expect(
      executeResume(
        'thread-abc',
        'continue',
        {
          environment: {},
          bypassSandbox: false,
          preChecked: {
            available: true as const,
            version: '1.0.0',
            authState: 'unauthenticated' as const,
            authError: customError,
          },
        },
      ),
    ).rejects.toThrow(customError);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('unknown auth state spawns process (fail-open)', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    const result = await executeResume(
      'thread-abc',
      'continue',
      {
        environment: {},
        model: 'o4-mini',
        bypassSandbox: false,
        preChecked: { available: true as const, version: '1.0.0', authState: 'unknown' as const },
      },
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(result.response).toBe('OK');
  });

  it('authenticated state spawns process, detectCodexCli not called', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume(
      'thread-abc',
      'continue',
      {
        environment: {},
        model: 'o4-mini',
        bypassSandbox: false,
        preChecked: { available: true as const, version: '1.0.0', authState: 'authenticated' as const },
      },
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });
});

describe('preChecked auth guard for executeFork', () => {
  const agentOk = agentMessage();
  const unauthChecked = {
    available: true as const,
    version: '1.0.0',
    authState: 'unauthenticated' as const,
    authError: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
  };

  it('unauthenticated throws before spawn, detectCodexCli not called', async () => {
    await expect(
      executeFork('thread-orig', 'Continue from where we left off.', { environment: {}, bypassSandbox: false, preChecked: unauthChecked }),
    ).rejects.toThrow('Codex CLI is not authenticated');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('thrown message matches cli.authError verbatim', async () => {
    const customError = 'Fork-specific custom auth error';
    await expect(
      executeFork('thread-orig', 'prompt', {
        environment: {},
        bypassSandbox: false,
        preChecked: { ...unauthChecked, authError: customError },
      }),
    ).rejects.toThrow(customError);
  });

  it('unknown auth state spawns process (fail-open), detectCodexCli not called', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    const result = await executeFork(
      'thread-orig',
      'do something new',
      {
        environment: {},
        model: 'o4-mini',
        bypassSandbox: false,
        preChecked: { available: true as const, version: '1.0.0', authState: 'unknown' as const },
      },
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(result.response).toBe('OK');
  });

  it('authenticated state spawns process, detectCodexCli not called', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeFork(
      'thread-orig',
      'Continue from where we left off.',
      {
        environment: {},
        model: 'o4-mini',
        bypassSandbox: false,
        preChecked: { available: true as const, version: '1.0.0', authState: 'authenticated' as const },
      },
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
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

    const promise = executeOneShot('test', withAuthenticatedCli());
    const assertion = expect(promise).rejects.toThrow('inactivity');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await assertion;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not kill active process producing output', async () => {
    mockCliAvailable();
    const proc = createIdleProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = executeOneShot('test', withAuthenticatedCli());

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

    const promise = executeOneShot('test', withAuthenticatedCli());
    const assertion = expect(promise).rejects.toThrow('10 minutes of inactivity');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await assertion;
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
  // executeOneShot still needs one tick so the async call reaches spawnCli and
  // attaches its event listeners before we push data or emit close.

  it('resolves with aborted=true and preserves partial output when signal fires', async () => {
    mockCliAvailable();
    const proc = createManualProcess();
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const promise = executeOneShot('test', withAuthenticatedCli({ signal: controller.signal }));

    await Promise.resolve(); // let spawnCli attach listeners

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
    const promise = executeOneShot('test', withAuthenticatedCli({ signal: controller.signal }));

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
    const promise = executeOneShot('test', withAuthenticatedCli({ signal: controller.signal }));

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
      const promise = executeOneShot('test', withAuthenticatedCli({ signal: controller.signal }));

      await vi.advanceTimersByTimeAsync(0); // flush microtasks so spawnCli attaches listeners

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
    const output = agentMessage();
    mockSpawn.mockReturnValue(createMockProcess(output, 0));

    await executeOneShot('test', withAuthenticatedCli());
    killAllChildren();

    const proc2 = createMockProcess(output, 0);
    const killSpy = vi.fn();
    (proc2 as unknown as { kill: ReturnType<typeof vi.fn> }).kill = killSpy;
    mockSpawn.mockReturnValue(proc2);

    killAllChildren();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('ensureMultiAgent', () => {
  const originalHome = process.env.HOME;
  const homesToClean = new Set<string>();

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const home of homesToClean) {
      rmSync(home, { recursive: true, force: true });
    }
    homesToClean.clear();
  });

  it('writes multi_agent = true when config is missing', async () => {
    const home = mkdtempSync(join('/tmp', 'coral-executor-home-'));
    homesToClean.add(home);
    process.env.HOME = home;

    mockCliAvailable();
    mockAgentProcess();

    await executeOneShot('test', withAuthenticatedCli());

    const configPath = join(home, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe('[features]\nmulti_agent = true\n');
  });

  it("repeated calls don't rewrite after first success", async () => {
    const home = mkdtempSync(join('/tmp', 'coral-executor-home-'));
    homesToClean.add(home);
    process.env.HOME = home;

    mockCliAvailable();
    const okOutput = agentMessage();
    mockSpawn.mockReturnValue(createMockProcess(okOutput, 0));
    await executeOneShot('first', withAuthenticatedCli());

    const configPath = join(home, '.codex', 'config.toml');
    const firstMtime = statSync(configPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    mockSpawn.mockReturnValue(createMockProcess(okOutput, 0));
    await executeOneShot('second', withAuthenticatedCli());

    const secondMtime = statSync(configPath).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it('existing config with multi_agent = true remains unchanged', async () => {
    const home = mkdtempSync(join('/tmp', 'coral-executor-home-'));
    homesToClean.add(home);
    process.env.HOME = home;
    mkdirSync(join(home, '.codex'), { recursive: true });
    const configPath = join(home, '.codex', 'config.toml');
    const existing = '[features]\nmulti_agent = true\nother_flag = true\n';
    writeFileSync(configPath, existing);

    mockCliAvailable();
    mockAgentProcess();

    await executeOneShot('test', withAuthenticatedCli());

    expect(readFileSync(configPath, 'utf8')).toBe(existing);
  });
});
