import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCodexCli, resetCliCache } from '../cli-detection.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockExecFileResult(error: Error | null, stdout: string): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(error, stdout, '');
    return undefined as never;
  });
}

describe('detectCodexCli', () => {
  beforeEach(() => {
    resetCliCache();
    mockExecFile.mockReset();
  });

  it('returns available when codex is installed', async () => {
    mockExecFileResult(null, 'codex 1.2.3\n');

    const result = await detectCodexCli();
    expect(result.available).toBe(true);
    expect(result.version).toBe('codex 1.2.3');
  });

  it('returns unavailable when codex is not found', async () => {
    mockExecFileResult(new Error('ENOENT'), '');

    const result = await detectCodexCli();
    expect(result.available).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('caches the result (execFile called only once)', async () => {
    mockExecFileResult(null, 'codex 1.0.0\n');

    await detectCodexCli();
    await detectCodexCli();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('re-detects after resetCliCache', async () => {
    mockExecFileResult(null, 'codex 2.0.0\n');

    await detectCodexCli();
    resetCliCache();
    await detectCodexCli();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
