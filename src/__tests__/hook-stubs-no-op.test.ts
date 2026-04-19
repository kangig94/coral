import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('hook stubs no-op (AC10)', () => {
  it('post-compact.mjs exits 0 on synthetic JSON stdin', () => {
    const result = spawnSync('node', ['hooks/post-compact.mjs'], {
      input: JSON.stringify({}),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    const logLine = JSON.parse(result.stderr.trim()) as { hook?: unknown; message?: unknown };
    expect(logLine).toMatchObject({
      hook: 'post-compact',
      message: 'stub: no-op until Phase 7 rewrites to read projection_jobs',
    });
  });

  it('pre-compact.mjs exits 0 on synthetic JSON stdin', () => {
    const result = spawnSync('node', ['hooks/pre-compact.mjs'], {
      input: JSON.stringify({}),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    const logLine = JSON.parse(result.stderr.trim()) as { hook?: unknown; message?: unknown };
    expect(logLine).toMatchObject({
      hook: 'pre-compact',
      message: 'stub: no-op until Phase 7 rewrites to read projection_jobs',
    });
  });
});
