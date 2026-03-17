import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRequest } from '../../../types.js';
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
      expect.objectContaining({ preChecked: validatedCli }),
    );
  });

  it('preflight caches the validated cli and forwards it to executeResume', async () => {
    const { codexProvider } = await loadProvider();

    await codexProvider.preflight?.();
    await codexProvider.execute(makeRequest({
      action: 'resume',
      conversationRef: 'thread-resume',
      prompt: 'Continue',
    }), makeRuntime());

    expect(mockState.detectCodexCli).toHaveBeenCalledTimes(1);
    expect(mockState.executeResume).toHaveBeenCalledWith(
      'thread-resume',
      'Continue',
      expect.objectContaining({ preChecked: validatedCli }),
    );
  });

  it('preflight caches the validated cli and forwards it to executeFork', async () => {
    const { codexProvider } = await loadProvider();

    await codexProvider.preflight?.();
    await codexProvider.execute(makeRequest({
      action: 'fork',
      conversationRef: 'thread-fork',
      prompt: 'Fork this',
    }), makeRuntime());

    expect(mockState.detectCodexCli).toHaveBeenCalledTimes(1);
    expect(mockState.executeFork).toHaveBeenCalledWith(
      'thread-fork',
      'Fork this',
      expect.objectContaining({ preChecked: validatedCli }),
    );
  });
});
