import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('hook stubs no-op (AC10)', () => {
  it('post-compact.mjs exits 0 on synthetic JSON stdin', () => {
    const out = execFileSync('node', ['hooks/post-compact.mjs'], {
      input: JSON.stringify({}),
      encoding: 'utf-8',
    });
    expect(out).toBe('');
  });

  it('pre-compact.mjs exits 0 on synthetic JSON stdin', () => {
    const out = execFileSync('node', ['hooks/pre-compact.mjs'], {
      input: JSON.stringify({}),
      encoding: 'utf-8',
    });
    expect(out).toBe('');
  });
});
