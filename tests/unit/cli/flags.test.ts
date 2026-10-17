import type * as NodeFs from 'node:fs';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'coral-input-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should keep a file path among other text literal', async () => {
    const resolveInput = await loadResolveInput();
    const filePath = join(tempDir, 'README.md');
    writeFileSync(filePath, 'file contents');

    expect(resolveInput(['fix', filePath, 'please'])).toBe(`fix ${filePath} please`);
  });

  it('should read whole file paths, including paths split at spaces and symlinks', async () => {
    const resolveInput = await loadResolveInput();
    const filePath = join(tempDir, 'prompt.md');
    const spacedPath = join(tempDir, 'prompt with spaces.md');
    const linkedPath = join(tempDir, 'linked prompt.md');
    writeFileSync(filePath, 'plain file contents');
    writeFileSync(spacedPath, 'spaced file contents');
    symlinkSync(filePath, linkedPath);

    expect(resolveInput([filePath])).toBe('plain file contents');
    expect(resolveInput([spacedPath])).toBe('spaced file contents');
    expect(resolveInput(spacedPath.split(' '))).toBe('spaced file contents');
    expect(resolveInput(linkedPath.split(' '))).toBe('plain file contents');
  });

  it('should keep directory paths and symlinks to directories literal', async () => {
    const resolveInput = await loadResolveInput();
    const linkedPath = join(tempDir, 'directory-link');
    symlinkSync(tempDir, linkedPath);

    expect(resolveInput([tempDir])).toBe(tempDir);
    expect(resolveInput([linkedPath])).toBe(linkedPath);
  });

  it('should read stdin only for a whole input of "-", leaving an embedded "-" literal', async () => {
    const resolveInput = await loadResolveInput();

    expect(resolveInput(['keep', '-', 'literal'])).toBe('keep - literal');
    expect(resolveInput(['-'])).toBe(STDIN_TEXT);
  });

  it('should refuse a second stdin input in the same command', async () => {
    const resolveInput = await loadResolveInput();
    resolveInput(['-']);

    expect(resolveInput(['keep', '-', 'literal'])).toBe('keep - literal');
    expect(() => resolveInput(['-'])).toThrow('Only one input per command can be read from stdin ("-")');
  });
});

it('accepts duplicate job IDs once in their original order', async () => {
  const { parseJobIds } = await import('#src/cli/flags.js');
  expect(parseJobIds('a,b a b,c')).toEqual(['a', 'b', 'c']);
});

describe('input help', () => {
  it('documents the whole-input rule on every option resolved by resolveInput', async () => {
    const { Command } = await import('commander');
    const { registerProviderCommands } = await import('#src/cli/commands/provider.js');
    const { registerWorkflowCommands } = await import('#src/cli/commands/workflow.js');
    const { createBuiltInProviderRegistry } = await import('#src/providers/bootstrap.js');
    const program = new Command();
    registerProviderCommands(program, createBuiltInProviderRegistry());
    registerWorkflowCommands(program);
    type ResolvedOption = [InstanceType<typeof Command>, string];
    const workflow = program.commands.find((command) => command.name() === 'workflow')!;
    const options: ResolvedOption[] = [
      ...program.commands
        .filter((command) => command !== workflow)
        .map((command): ResolvedOption => [command, '--input']),
      ...['--start-prompt', '--context'].map((flag): ResolvedOption => [workflow, flag]),
    ];
    expect(options.length).toBeGreaterThan(2);
    for (const [command, flag] of options) {
      const description = command.options.find((option) => option.long === flag)!.description.replace(/\s+/gu, ' ');
      expect(description).toContain('the whole input is read if it names an existing regular file');
      expect(description).not.toContain('a single existing path is read as a file');
    }
  });
});
