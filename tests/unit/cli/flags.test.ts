import type * as NodeFs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STDIN_TEXT = 'prompt with `backticks`, $(subshell) and $VAR kept literal';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], options?: unknown) =>
      path === 0 ? STDIN_TEXT : actual.readFileSync(path, options as BufferEncoding),
    ),
  };
});

async function loadResolveInput() {
  vi.resetModules();
  return (await import('#src/cli/flags.js')).resolveInput;
}

describe('resolveInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should read the input from stdin when the value is "-"', async () => {
    const resolveInput = await loadResolveInput();

    expect(resolveInput(['-'])).toBe(STDIN_TEXT);
  });

  it('should refuse a second stdin input in the same command', async () => {
    const resolveInput = await loadResolveInput();
    resolveInput(['-']);

    expect(() => resolveInput(['-'])).toThrow(/stdin/);
  });
});
