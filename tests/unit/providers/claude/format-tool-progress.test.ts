import { describe, expect, it } from 'vitest';
import { formatToolProgress } from '#src/providers/claude/progress.js';
import { truncate } from '#src/infra/text.js';

const projectRoot = '/repo';
const projectMainFile = '/repo/src/main.ts';

describe('truncate', () => {
  it('returns original text when below max length', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates text and appends ellipsis when over max length', () => {
    expect(truncate('a'.repeat(81))).toBe(`${'a'.repeat(80)}...`);
  });
});

describe('formatToolProgress', () => {
  it('formats Read with relative path when inside projectRoot', () => {
    expect(formatToolProgress('Read', { file_path: projectMainFile, offset: 12, limit: 8 }, projectRoot)).toBe(
      'Read(src/main.ts:12-20)',
    );
    expect(formatToolProgress('Read', { file_path: projectMainFile, offset: 12 }, projectRoot)).toBe(
      'Read(src/main.ts:12+)',
    );
    expect(formatToolProgress('Read', { file_path: projectMainFile }, projectRoot)).toBe('Read(src/main.ts)');
  });

  it('formats Read with absolute path when outside projectRoot', () => {
    expect(formatToolProgress('Read', { file_path: '/tmp/src/main.ts' }, projectRoot)).toBe('Read(/tmp/src/main.ts)');
  });

  it('formats Edit and Write tools', () => {
    expect(
      formatToolProgress(
        'Edit',
        { file_path: projectMainFile, old_string: 'before\nline', new_string: 'after\nline' },
        projectRoot,
      ),
    ).toBe('Update(src/main.ts, "before" → "after")');
    expect(formatToolProgress('Write', { file_path: projectMainFile }, projectRoot)).toBe('Write(src/main.ts)');
  });

  it('formats Bash/Grep/Glob/Agent tools', () => {
    expect(formatToolProgress('Bash', { description: 'Run tests' }, projectRoot)).toBe('Bash(Run tests)');
    expect(formatToolProgress('Bash', { command: 'npm test' }, projectRoot)).toBe('Bash(npm test)');
    expect(formatToolProgress('Grep', { pattern: 'TODO' }, projectRoot)).toBe('Grep(TODO)');
    expect(formatToolProgress('Glob', { pattern: '**/*.ts' }, projectRoot)).toBe('Glob(**/*.ts)');
    expect(formatToolProgress('Agent', { description: 'parallel subtask' }, projectRoot)).toBe('Agent(parallel subtask)');
  });

  it('falls back to generic format for unknown tool', () => {
    expect(formatToolProgress('UnknownTool', {}, projectRoot)).toBe('Using: UnknownTool');
  });
});

describe('truncate — adversarial', () => {
  it.each([
    { text: 'A'.repeat(80), length: 80 },
    { text: 'B'.repeat(79), length: 79 },
  ])('does not truncate string of $length chars', ({ text }) => {
    expect(truncate(text)).toBe(text);
    expect(truncate(text).endsWith('...')).toBe(false);
  });

  it('truncates string of 81 chars with ellipsis', () => {
    const result = truncate('A'.repeat(81));
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBe(83);
  });

  it('truncates at custom maxLen=10', () => {
    const result = truncate('0123456789X', 10);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBe(13);
  });

  it('does not truncate when string fits within custom maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('handles maxLen=3', () => {
    const result = truncate('abcdef', 3);
    expect(result).toBe('abc...');
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles empty and single-char strings', () => {
    expect(truncate('')).toBe('');
    expect(truncate('x')).toBe('x');
  });
});

describe('formatToolProgress — adversarial', () => {
  describe('Read with partial range arguments', () => {
    it.each([
      { label: 'only offset', input: { file_path: '/src/foo.ts', offset: 5 }, expected: 'Read(/src/foo.ts:5+)' },
      { label: 'only limit', input: { file_path: '/src/bar.ts', limit: 50 }, expected: 'Read(/src/bar.ts)' },
      {
        label: 'both offset and limit',
        input: { file_path: 'main.ts', offset: 10, limit: 20 },
        expected: 'Read(main.ts:10-30)',
      },
      { label: 'empty file_path', input: { file_path: '' }, expected: 'Read()' },
      { label: 'missing file_path', input: {}, expected: 'Read(file)' },
    ])('handles Read with $label', ({ input, expected }) => {
      expect(formatToolProgress('Read', input, projectRoot)).toBe(expected);
    });

    it('treats offset=0 as a provided offset', () => {
      const withZero = formatToolProgress('Read', { file_path: '/x.ts', offset: 0, limit: 10 }, projectRoot);
      const withoutOffset = formatToolProgress('Read', { file_path: '/x.ts', limit: 10 }, projectRoot);
      expect(typeof withZero).toBe('string');
      expect(typeof withoutOffset).toBe('string');
      expect(withZero).toContain('x.ts');
    });
  });

  describe('Edit edge cases', () => {
    it.each([
      {
        label: 'empty old_string',
        input: { file_path: 'target.ts', old_string: '', new_string: 'replacement' },
        expected: 'Update(target.ts, "" → "replacement")',
      },
      {
        label: 'empty new_string',
        input: { file_path: 'target.ts', old_string: 'old content', new_string: '' },
        expected: 'Update(target.ts, "old content" → "")',
      },
      {
        label: 'both strings empty',
        input: { file_path: 'f.ts', old_string: '', new_string: '' },
        expected: 'Update(f.ts)',
      },
      {
        label: 'missing file_path',
        input: { old_string: 'x', new_string: 'y' },
        expected: 'Update(file, "x" → "y")',
      },
    ])('handles Edit with $label', ({ input, expected }) => {
      expect(formatToolProgress('Edit', input, projectRoot)).toBe(expected);
    });

    it('truncates long old_string in Edit display', () => {
      const message = formatToolProgress('Edit', {
        file_path: 'big.ts',
        old_string: 'X'.repeat(200),
        new_string: 'replacement',
      }, projectRoot);
      expect(message.length).toBeLessThan(300);
    });
  });

  describe('Bash edge cases', () => {
    it.each([
      { label: 'empty command and no description', input: { command: '' }, expected: 'Bash()' },
      { label: 'no input fields at all', input: {}, expected: 'Bash()' },
    ])('handles Bash with $label', ({ input, expected }) => {
      expect(formatToolProgress('Bash', input, projectRoot)).toBe(expected);
    });

    it('truncates Bash description when it exceeds limit', () => {
      const message = formatToolProgress('Bash', { command: 'ls', description: 'D'.repeat(200) }, projectRoot);
      expect(message.length).toBeLessThan(300);
      expect(message).toMatch(/^Bash\(/);
    });

    it('truncates Bash command when no description and command is long', () => {
      const longCmd = 'find /home -name "*.ts" -exec grep -l "import" {} \\; | sort | uniq -c | sort -rn | head -20';
      const message = formatToolProgress('Bash', { command: longCmd }, projectRoot);
      expect(message.length).toBeLessThan(300);
      expect(message).toMatch(/^Bash\(/);
    });

    it('prefers description over command when both present', () => {
      const message = formatToolProgress('Bash', {
        command: 'ls -la /some/path',
        description: 'List directory contents',
      }, projectRoot);
      expect(message).toContain('List directory contents');
    });
  });

  describe('Grep and Glob edge cases', () => {
    it('formats Grep with only pattern', () => {
      expect(formatToolProgress('Grep', { pattern: 'TODO' }, projectRoot)).toBe('Grep(TODO)');
    });

    it('formats Glob with only pattern', () => {
      expect(formatToolProgress('Glob', { pattern: '**/*.ts' }, projectRoot)).toBe('Glob(**/*.ts)');
    });

    it.each([
      { tool: 'Grep', input: { pattern: '' }, expected: 'Grep()' },
      { tool: 'Grep', input: {}, expected: 'Grep()' },
      { tool: 'Glob', input: { pattern: '' }, expected: 'Glob()' },
    ])('handles $tool with sparse input', ({ tool, input, expected }) => {
      expect(formatToolProgress(tool, input, projectRoot)).toBe(expected);
    });
  });

  describe('Write and Agent edge cases', () => {
    it('formats Write with path outside cwd', () => {
      const message = formatToolProgress('Write', {
        file_path: '/very/deep/nested/path/to/output.ts',
        content: 'file content',
      }, projectRoot);
      expect(message).toBe('Write(/very/deep/nested/path/to/output.ts)');
    });

    it('formats Write with missing file_path', () => {
      expect(formatToolProgress('Write', { content: 'hello' }, projectRoot)).toBe('Write(file)');
    });

    it('formats Agent with missing description field', () => {
      expect(formatToolProgress('Agent', {}, projectRoot)).toBe('Agent()');
    });

    it('truncates long Agent description', () => {
      const message = formatToolProgress('Agent', { description: 'A'.repeat(200) }, projectRoot);
      expect(message.length).toBeLessThan(300);
      expect(message).toMatch(/^Agent\(/);
    });
  });

  describe('fallback and non-string file_path values', () => {
    it('returns "Using: <name>" for unknown tool', () => {
      const message = formatToolProgress('MyCustomTool', { arg: 'val' }, projectRoot);
      expect(message).toContain('MyCustomTool');
    });

    it('handles empty tool name for fallback', () => {
      expect(formatToolProgress('', {}, projectRoot)).toBe('Using: ');
    });

    it.each([
      { tool: 'Read', input: { file_path: null as unknown as string }, expected: 'Read(file)' },
      {
        tool: 'Edit',
        input: { file_path: 42 as unknown as string, old_string: 'x', new_string: 'y' },
        expected: 'Update(file, "x" → "y")',
      },
    ])('handles non-string file_path for $tool', ({ tool, input, expected }) => {
      expect(formatToolProgress(tool, input, projectRoot)).toBe(expected);
    });
  });
});
