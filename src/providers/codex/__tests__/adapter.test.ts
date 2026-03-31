import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../../shared/types.js';
import type { ProviderRuntime } from '../../types.js';

const mockState = vi.hoisted(() => ({
  detectCodexCli: vi.fn(),
  executeOneShot: vi.fn(),
  executeResume: vi.fn(),
  executeFork: vi.fn(),
}));

vi.mock('../../cli-detection.js', () => ({
  detectCodexCli: mockState.detectCodexCli,
}));

vi.mock('../codex-executor.js', () => ({
  executeOneShot: mockState.executeOneShot,
  executeResume: mockState.executeResume,
  executeFork: mockState.executeFork,
}));

const validatedCli = {
  available: true as const,
  version: '1.0.0',
  authState: 'authenticated' as const,
};

const baseResult = {
  response: 'ok',
  sessionId: 'thread-1',
  model: 'gpt-5.4',
  durationMs: 10,
  exitCode: 0,
  errors: [],
  warnings: [],
  aborted: false,
};

function makeRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    action: 'exec',
    sessionId: 'job-1',
    prompt: 'Run checks',
    bypassPermissions: false,
    coralEnv: {},
    ...overrides,
  };
}

function makeRuntime(): ProviderRuntime {
  return {
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    runCli: vi.fn(),
  };
}

async function loadProvider() {
  vi.resetModules();
  return import('../adapter.js');
}

describe('codex adapter preflight handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.detectCodexCli.mockResolvedValue(validatedCli);
    mockState.executeOneShot.mockResolvedValue(baseResult);
    mockState.executeResume.mockResolvedValue(baseResult);
    mockState.executeFork.mockResolvedValue(baseResult);
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('preflight caches the validated cli and forwards it to executeOneShot', async () => {
    const { codexProvider } = await loadProvider();

    await codexProvider.preflight?.();
    await codexProvider.execute(makeRequest(), makeRuntime());

    expect(mockState.detectCodexCli).toHaveBeenCalledTimes(1);
    expect(mockState.executeOneShot).toHaveBeenCalledWith(
      'Run checks',
      expect.objectContaining({ preChecked: validatedCli, runCli: expect.any(Function) }),
    );
  });

  it('preflight caches the validated cli and forwards it to executeResume', async () => {
    const { codexProvider } = await loadProvider();

    await codexProvider.preflight?.();
    await codexProvider.execute(
      makeRequest({
        action: 'resume',
        conversationRef: 'thread-resume',
        prompt: 'Continue',
      }),
      makeRuntime(),
    );

    expect(mockState.detectCodexCli).toHaveBeenCalledTimes(1);
    expect(mockState.executeResume).toHaveBeenCalledWith(
      'thread-resume',
      'Continue',
      expect.objectContaining({ preChecked: validatedCli, runCli: expect.any(Function) }),
    );
  });

  it('preflight caches the validated cli and forwards it to executeFork', async () => {
    const { codexProvider } = await loadProvider();

    await codexProvider.preflight?.();
    await codexProvider.execute(
      makeRequest({
        action: 'fork',
        conversationRef: 'thread-fork',
        prompt: 'Fork this',
      }),
      makeRuntime(),
    );

    expect(mockState.detectCodexCli).toHaveBeenCalledTimes(1);
    expect(mockState.executeFork).toHaveBeenCalledWith(
      'thread-fork',
      'Fork this',
      expect.objectContaining({ preChecked: validatedCli, runCli: expect.any(Function) }),
    );
  });
});

describe('codex adapter recovery contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-recovery-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('finalizes from stdout file with valid Codex JSONL output', async () => {
    const { codexProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.jsonl');
    const stderrPath = join(tmpDir, 'stderr.log');
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"recovered-thread"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Recovered output"}}',
    ].join('\n');
    writeFileSync(stdoutPath, jsonlOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await codexProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
    });

    expect(result.content).toBe('Recovered output');
    expect(result.conversationRef).toBe('recovered-thread');
    expect(result.exitCode).toBe(0);
  });

  it('falls back to raw content for unparseable stdout', async () => {
    const { codexProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.jsonl');
    const stderrPath = join(tmpDir, 'stderr.log');
    const rawContent = 'This is not JSONL, just plain text output.';
    writeFileSync(stdoutPath, rawContent, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await codexProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 1,
      signal: null,
    });

    expect(result.content).toBe(rawContent);
    expect(result.exitCode).toBe(1);
  });

  it('includes kill signal notice in raw fallback', async () => {
    const { codexProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.jsonl');
    const stderrPath = join(tmpDir, 'stderr.log');
    writeFileSync(stdoutPath, 'raw output', 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await codexProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: null,
      signal: 'SIGTERM',
    });

    expect(result.content).toBe('raw output');
    expect(result.notice).toBe('killed by SIGTERM');
  });

  it('uses fallbackConversationRef when JSONL lacks sessionId', async () => {
    const { codexProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.jsonl');
    const stderrPath = join(tmpDir, 'stderr.log');
    // JSONL with a response but no thread.started event
    const jsonlOutput = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"No session"}}\n';
    writeFileSync(stdoutPath, jsonlOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await codexProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 0,
      signal: null,
      fallbackConversationRef: 'fallback-thread',
    });

    expect(result.content).toBe('No session');
    expect(result.conversationRef).toBe('fallback-thread');
  });

  it('captures errors from JSONL in recovered result', async () => {
    const { codexProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.jsonl');
    const stderrPath = join(tmpDir, 'stderr.log');
    const jsonlOutput = '{"type":"error","message":"Rate limit exceeded"}\n';
    writeFileSync(stdoutPath, jsonlOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await codexProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: 1,
      signal: null,
    });

    expect(result.errors).toEqual(['Rate limit exceeded']);
  });

  it('marks parsed recovered output as aborted when the wrapper exited by signal', async () => {
    const { codexProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.jsonl');
    const stderrPath = join(tmpDir, 'stderr.log');
    const jsonlOutput = [
      '{"type":"thread.started","thread_id":"recovered-thread"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Recovered output"}}',
    ].join('\n');
    writeFileSync(stdoutPath, jsonlOutput, 'utf-8');
    writeFileSync(stderrPath, '', 'utf-8');

    const result = await codexProvider.recovery!.finalizeFromArtifacts({
      stdoutPath,
      stderrPath,
      exitCode: null,
      signal: 'SIGTERM',
    });

    expect(result.aborted).toBe(true);
    expect(result.conversationRef).toBe('recovered-thread');
  });

  it('extracts progress from complete appended lines only', async () => {
    const { codexProvider } = await loadProvider();

    const stdoutPath = join(tmpDir, 'stdout.jsonl');
    const firstLine = '{"type":"turn.started"}\n';
    const partialLine = '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Recovered output"}}';
    writeFileSync(stdoutPath, `${firstLine}${partialLine}`, 'utf-8');

    const first = codexProvider.recovery!.extractProgress!({ stdoutPath, fromOffset: 0 });
    expect(first.messages).toEqual(['Processing...']);
    expect(first.newOffset).toBe(Buffer.byteLength(firstLine));

    writeFileSync(stdoutPath, `${firstLine}${partialLine}\n`, 'utf-8');

    const second = codexProvider.recovery!.extractProgress!({ stdoutPath, fromOffset: first.newOffset });
    expect(second.messages).toEqual(['Generating response...']);
    expect(second.newOffset).toBeGreaterThan(first.newOffset);
  });
});
