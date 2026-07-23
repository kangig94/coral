import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function hookEnv(projectDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env['CORAL_CHILD'];
  return env;
}

describe('hook stubs no-op', () => {
  it('post-compact.mjs exits 0 on synthetic JSON stdin', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'coral-hook-stub-'));
    const result = spawnSync('node', ['clients/hooks/post-compact.mjs'], {
      input: JSON.stringify({ cwd: projectDir }),
      encoding: 'utf-8',
      env: hookEnv(projectDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    const logLine = JSON.parse(result.stderr.trim()) as { hook?: unknown; message?: unknown };
    expect(logLine).toMatchObject({
      hook: 'post-compact',
      message: 'no compact snapshot found',
    });
  });

  it('pre-compact.mjs exits 0 on synthetic JSON stdin', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'coral-hook-stub-'));
    const result = spawnSync('node', ['clients/hooks/pre-compact.mjs'], {
      input: JSON.stringify({ cwd: projectDir }),
      encoding: 'utf-8',
      env: hookEnv(projectDir),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    const logLine = JSON.parse(result.stderr.trim()) as { hook?: unknown; message?: unknown };
    expect(logLine).toMatchObject({
      hook: 'pre-compact',
      message: 'compact snapshot skipped',
    });
  });
});
