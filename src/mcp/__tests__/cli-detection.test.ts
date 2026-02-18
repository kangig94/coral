import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCodexCli, resetCliCache } from '../cli-detection.js';

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

describe('detectCodexCli', () => {
  beforeEach(() => {
    resetCliCache();
    mockExecFile.mockReset();
  });

  it('returns available when codex is installed', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, 'codex 1.2.3\n', '');
      return {} as any;
    });

    const result = await detectCodexCli();
    expect(result.available).toBe(true);
    expect(result.version).toBe('codex 1.2.3');
  });

  it('returns unavailable when codex is not found', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(new Error('ENOENT'), '', '');
      return {} as any;
    });

    const result = await detectCodexCli();
    expect(result.available).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('caches the result (execFile called only once)', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, 'codex 1.0.0\n', '');
      return {} as any;
    });

    await detectCodexCli();
    await detectCodexCli();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('re-detects after resetCliCache', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, 'codex 2.0.0\n', '');
      return {} as any;
    });

    await detectCodexCli();
    resetCliCache();
    await detectCodexCli();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
