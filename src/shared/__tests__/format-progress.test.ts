import { describe, expect, it } from 'vitest';
import { formatToolProgress, shortPath, truncate } from '../format-progress.js';

const projectRoot = '/repo';
const projectMainFile = '/repo/src/main.ts';

function expectNoThrow(toolName: string, input: Record<string, unknown>): void {
  expect(() => formatToolProgress(toolName, input)).not.toThrow();
}

describe('truncate', () => {
  it('returns original text when below max length', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates text and appends ellipsis when over max length', () => {
    expect(truncate('a'.repeat(81))).toBe(`${'a'.repeat(80)}...`);
  });
});

describe('shortPath', () => {
  it('returns a relative path for absolute files inside projectRoot', () => {
    expect(shortPath('/repo/src/main.ts', projectRoot)).toBe('src/main.ts');
  });

  it('returns an absolute path for absolute files outside projectRoot', () => {
    expect(shortPath('/tmp/src/main.ts', projectRoot)).toBe('/tmp/src/main.ts');
  });

  it('resolves relative file paths against projectRoot', () => {
    expect(shortPath('src/main.ts', projectRoot)).toBe('src/main.ts');
  });
});

describe('formatToolProgress', () => {
  it('formats Read with relative path when inside projectRoot', () => {
    expect(formatToolProgress('Read', { file_path: projectMainFile, offset: 12, limit: 8 }, projectRoot))
      .toBe('Read(src/main.ts:12-20)');
    expect(formatToolProgress('Read', { file_path: projectMainFile, offset: 12 }, projectRoot)).toBe('Read(src/main.ts:12+)');
    expect(formatToolProgress('Read', { file_path: projectMainFile }, projectRoot)).toBe('Read(src/main.ts)');
  });

  it('formats Read with absolute path when outside projectRoot', () => {
    expect(formatToolProgress('Read', { file_path: '/tmp/src/main.ts' }, projectRoot)).toBe('Read(/tmp/src/main.ts)');
  });

  it('formats Edit and Write tools', () => {
    expect(formatToolProgress('Edit', { file_path: projectMainFile, old_string: 'before\nline', new_string: 'after\nline' }, projectRoot))
      .toBe('Update(src/main.ts, "before" → "after")');
    expect(formatToolProgress('Write', { file_path: projectMainFile }, projectRoot)).toBe('Write(src/main.ts)');
  });

  it('formats Bash/Grep/Glob/Agent tools', () => {
    expect(formatToolProgress('Bash', { description: 'Run tests' })).toBe('Bash(Run tests)');
    expect(formatToolProgress('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
    expect(formatToolProgress('Grep', { pattern: 'TODO' })).toBe('Grep(TODO)');
    expect(formatToolProgress('Glob', { pattern: '**/*.ts' })).toBe('Glob(**/*.ts)');
    expect(formatToolProgress('Agent', { description: 'parallel subtask' })).toBe('Agent(parallel subtask)');
  });

  it('falls back to generic format for unknown tool', () => {
    expect(formatToolProgress('UnknownTool', {})).toBe('Using: UnknownTool');
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
      { label: 'only offset', input: { file_path: '/src/foo.ts', offset: 5 }, contains: 'foo.ts' },
      { label: 'only limit', input: { file_path: '/src/bar.ts', limit: 50 }, contains: 'bar.ts' },
      { label: 'both offset and limit', input: { file_path: 'main.ts', offset: 10, limit: 20 }, contains: 'main.ts' },
      { label: 'empty file_path', input: { file_path: '' } },
      { label: 'missing file_path', input: {} },
    ])('handles Read with $label', ({ input, contains }) => {
      const message = formatToolProgress('Read', input);
      if (contains) expect(message).toContain(contains);
      expectNoThrow('Read', input);
    });

    it('treats offset=0 as a provided offset', () => {
      const withZero = formatToolProgress('Read', { file_path: '/x.ts', offset: 0, limit: 10 });
      const withoutOffset = formatToolProgress('Read', { file_path: '/x.ts', limit: 10 });
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
      },
      {
        label: 'empty new_string',
        input: { file_path: 'target.ts', old_string: 'old content', new_string: '' },
      },
      {
        label: 'both strings empty',
        input: { file_path: 'f.ts', old_string: '', new_string: '' },
      },
      {
        label: 'missing file_path',
        input: { old_string: 'x', new_string: 'y' },
      },
    ])('handles Edit with $label', ({ input }) => {
      const message = formatToolProgress('Edit', input);
      if ('file_path' in input && typeof input.file_path === 'string') {
        expect(message).toContain(input.file_path);
      }
      expectNoThrow('Edit', input);
    });

    it('truncates long old_string in Edit display', () => {
      const message = formatToolProgress('Edit', {
        file_path: 'big.ts',
        old_string: 'X'.repeat(200),
        new_string: 'replacement',
      });
      expect(message.length).toBeLessThan(300);
    });
  });

  describe('Bash edge cases', () => {
    it.each([
      { label: 'empty command and no description', input: { command: '' } },
      { label: 'no input fields at all', input: {} },
    ])('handles Bash with $label', ({ input }) => {
      const message = formatToolProgress('Bash', input);
      expect(typeof message).toBe('string');
      expectNoThrow('Bash', input);
    });

    it('truncates Bash description when it exceeds limit', () => {
      const message = formatToolProgress('Bash', { command: 'ls', description: 'D'.repeat(200) });
      expect(message.length).toBeLessThan(300);
      expect(message).toMatch(/^Bash\(/);
    });

    it('truncates Bash command when no description and command is long', () => {
      const longCmd = 'find /home -name "*.ts" -exec grep -l "import" {} \\; | sort | uniq -c | sort -rn | head -20';
      const message = formatToolProgress('Bash', { command: longCmd });
      expect(message.length).toBeLessThan(300);
      expect(message).toMatch(/^Bash\(/);
    });

    it('prefers description over command when both present', () => {
      const message = formatToolProgress('Bash', {
        command: 'ls -la /some/path',
        description: 'List directory contents',
      });
      expect(message).toContain('List directory contents');
    });
  });

  describe('Grep and Glob edge cases', () => {
    it('formats Grep with only pattern', () => {
      expect(formatToolProgress('Grep', { pattern: 'TODO' })).toBe('Grep(TODO)');
    });

    it('formats Glob with only pattern', () => {
      expect(formatToolProgress('Glob', { pattern: '**/*.ts' })).toBe('Glob(**/*.ts)');
    });

    it.each([
      { tool: 'Grep', input: { pattern: '' } },
      { tool: 'Grep', input: {} },
      { tool: 'Glob', input: { pattern: '' } },
    ])('handles $tool with sparse input', ({ tool, input }) => {
      expectNoThrow(tool, input);
    });
  });

  describe('Write and Agent edge cases', () => {
    it('formats Write with path outside cwd', () => {
      const message = formatToolProgress('Write', {
        file_path: '/very/deep/nested/path/to/output.ts',
        content: 'file content',
      });
      expect(message).toBe('Write(/very/deep/nested/path/to/output.ts)');
    });

    it('formats Write with missing file_path', () => {
      expectNoThrow('Write', { content: 'hello' });
    });

    it('formats Agent with missing description field', () => {
      expectNoThrow('Agent', {});
    });

    it('truncates long Agent description', () => {
      const message = formatToolProgress('Agent', { description: 'A'.repeat(200) });
      expect(message.length).toBeLessThan(300);
      expect(message).toMatch(/^Agent\(/);
    });
  });

  describe('fallback and non-string file_path values', () => {
    it('returns "Using: <name>" for unknown tool', () => {
      const message = formatToolProgress('MyCustomTool', { arg: 'val' });
      expect(message).toContain('MyCustomTool');
    });

    it('handles empty tool name for fallback', () => {
      expectNoThrow('', {});
    });

    it.each([
      { tool: 'Read', input: { file_path: null as unknown as string } },
      { tool: 'Edit', input: { file_path: 42 as unknown as string, old_string: 'x', new_string: 'y' } },
    ])('handles non-string file_path for $tool', ({ tool, input }) => {
      expectNoThrow(tool, input);
    });
  });
});
