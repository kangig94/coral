/**
 * Red-team adversarial tests for codex-executor.ts auth guard paths.
 *
 * Gaps targeted (non-overlapping with codex-executor.test.ts):
 *   - executeResume with preChecked.authState='unauthenticated' → throws before spawn
 *     (defense-in-depth guard; existing tests only cover executeOneShot for this)
 *   - executeFork with preChecked.authState='unauthenticated' → throws before spawn
 *   - executeResume with preChecked.authState='unknown' → spawn called (fail-open path)
 *   - executeFork with preChecked.authState='unknown' → spawn called (fail-open path)
 *   - The auth error thrown by the executor matches cli.authError verbatim
 *     (not a rephrased message — executor re-throws cli.authError directly)
 *   - preChecked='unauthenticated' suppresses detectCodexCli() call in executeResume/executeFork
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { executeResume, executeFork } from '../codex-executor.js';

const mockDetect = vi.mocked(detectCodexCli);
const mockSpawn = vi.mocked(spawn);

function createMockProcess(stdout: string, code: number): ChildProcess {
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
  setTimeout(() => {
    stdoutStream.push(stdout);
    stdoutStream.push(null);
    proc.emit('close', code);
  }, 10);
  return proc;
}

const agentOk = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"OK"}}\n';

const unauthChecked = {
  available: true as const,
  version: '1.0.0',
  authState: 'unauthenticated' as const,
  authError: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
};

const unknownChecked = {
  available: true as const,
  version: '1.0.0',
  authState: 'unknown' as const,
};

const authChecked = {
  available: true as const,
  version: '1.0.0',
  authState: 'authenticated' as const,
};

beforeEach(() => {
  mockDetect.mockReset();
  mockSpawn.mockReset();
});

describe('executeResume: preChecked defense-in-depth guard', () => {
  it('preChecked unauthenticated → throws before spawn, detectCodexCli not called', async () => {
    await expect(
      executeResume(
        'thread-abc', 'continue', undefined, undefined, undefined, false,
        undefined, undefined, unauthChecked,
      ),
    ).rejects.toThrow('Codex CLI is not authenticated');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('preChecked unauthenticated → thrown message matches cli.authError verbatim', async () => {
    const customError = 'Totally custom auth error message for this test';
    const customUnauth = { ...unauthChecked, authError: customError };

    await expect(
      executeResume(
        'thread-abc', 'continue', undefined, undefined, undefined, false,
        undefined, undefined, customUnauth,
      ),
    ).rejects.toThrow(customError);
  });

  it('preChecked unknown → spawn is called (fail-open), detectCodexCli not called', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    const result = await executeResume(
      'thread-abc', 'continue', 'o4-mini', undefined, undefined, false,
      undefined, undefined, unknownChecked,
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(result.response).toBe('OK');
  });

  it('preChecked authenticated → spawn is called, detectCodexCli not called', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeResume(
      'thread-abc', 'continue', 'o4-mini', undefined, undefined, false,
      undefined, undefined, authChecked,
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });
});

describe('executeFork: preChecked defense-in-depth guard', () => {
  it('preChecked unauthenticated → throws before spawn, detectCodexCli not called', async () => {
    await expect(
      executeFork(
        'thread-orig', undefined, undefined, undefined, undefined, false,
        undefined, undefined, unauthChecked,
      ),
    ).rejects.toThrow('Codex CLI is not authenticated');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('preChecked unauthenticated in executeFork → thrown message matches cli.authError verbatim', async () => {
    const customError = 'Fork-specific custom auth error';
    const customUnauth = { ...unauthChecked, authError: customError };

    await expect(
      executeFork(
        'thread-orig', 'prompt', undefined, undefined, undefined, false,
        undefined, undefined, customUnauth,
      ),
    ).rejects.toThrow(customError);
  });

  it('preChecked unknown in executeFork → spawn called (fail-open), detectCodexCli not called', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    const result = await executeFork(
      'thread-orig', 'do something new', 'o4-mini', undefined, undefined, false,
      undefined, undefined, unknownChecked,
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
    expect(result.response).toBe('OK');
  });

  it('preChecked authenticated in executeFork → spawn called, detectCodexCli not called', async () => {
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeFork(
      'thread-orig', undefined, 'o4-mini', undefined, undefined, false,
      undefined, undefined, authChecked,
    );

    expect(mockSpawn).toHaveBeenCalled();
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('executeFork without preChecked delegates to detectCodexCli (normal path)', async () => {
    mockDetect.mockResolvedValue(authChecked);
    mockSpawn.mockReturnValue(createMockProcess(agentOk, 0));

    await executeFork('thread-orig');

    expect(mockDetect).toHaveBeenCalledTimes(1);
  });
});
