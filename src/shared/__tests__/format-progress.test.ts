import { describe, it, expect } from 'vitest';
import { formatToolProgress, truncate } from '../format-progress.js';

describe('truncate', () => {
  it('returns original text when below max length', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates text and appends ellipsis when over max length', () => {
    expect(truncate('a'.repeat(81))).toBe(`${'a'.repeat(80)}...`);
  });
});

describe('formatToolProgress', () => {
  it('formats Read variants', () => {
    expect(formatToolProgress('Read', { file_path: '/tmp/src/main.ts', offset: 12, limit: 8 })).toBe('Read(main.ts:12-20)');
    expect(formatToolProgress('Read', { file_path: '/tmp/src/main.ts', offset: 12 })).toBe('Read(main.ts:12+)');
    expect(formatToolProgress('Read', { file_path: '/tmp/src/main.ts' })).toBe('Read(main.ts)');
  });

  it('formats Edit and Write tools', () => {
    expect(formatToolProgress('Edit', { file_path: '/tmp/main.ts', old_string: 'before\nline', new_string: 'after\nline' }))
      .toBe('Edit(main.ts, "before" → "after")');
    expect(formatToolProgress('Write', { file_path: '/tmp/main.ts' })).toBe('Write(main.ts)');
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
  describe('exact boundary behavior', () => {
    it('does not truncate string of exactly 80 chars', () => {
      const s = 'A'.repeat(80);
      expect(truncate(s)).toBe(s);
      expect(truncate(s).endsWith('...')).toBe(false);
    });

    it('truncates string of 81 chars with ellipsis', () => {
      const s = 'A'.repeat(81);
      const result = truncate(s);
      expect(result.endsWith('...')).toBe(true);
      // Contract: slice(maxLen) + '...' → total length is maxLen + 3
      expect(result.length).toBe(83);
    });

    it('does not truncate string of exactly 79 chars', () => {
      const s = 'B'.repeat(79);
      expect(truncate(s)).toBe(s);
    });
  });

  describe('custom maxLen', () => {
    it('truncates at custom maxLen=10', () => {
      const result = truncate('0123456789X', 10);
      expect(result.endsWith('...')).toBe(true);
      // Contract: slice(10) + '...' = 13 chars total
      expect(result.length).toBe(13);
    });

    it('does not truncate when string fits within custom maxLen', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('handles maxLen=3 (edge: at minimum useful length)', () => {
      const result = truncate('abcdef', 3);
      // Contract: slice(3) + '...' = 'abc...' (6 chars)
      expect(result).toBe('abc...');
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('edge inputs', () => {
    it('truncates empty string to empty string (no ellipsis)', () => {
      expect(truncate('')).toBe('');
    });

    it('truncates single char string to itself', () => {
      expect(truncate('x')).toBe('x');
    });
  });
});

describe('formatToolProgress — adversarial', () => {
  describe('Read with partial range arguments', () => {
    it('formats Read with only offset (no limit) — offset present, no limit', () => {
      const msg = formatToolProgress('Read', { file_path: '/src/foo.ts', offset: 5 });
      expect(msg).toContain('foo.ts');
      expect(() => formatToolProgress('Read', { file_path: '/src/foo.ts', offset: 5 })).not.toThrow();
    });

    it('formats Read with only limit (no offset)', () => {
      const msg = formatToolProgress('Read', { file_path: '/src/bar.ts', limit: 50 });
      expect(msg).toContain('bar.ts');
      expect(() => formatToolProgress('Read', { file_path: '/src/bar.ts', limit: 50 })).not.toThrow();
    });

    it('treats offset=0 as a provided offset (not "no offset")', () => {
      const withZero = formatToolProgress('Read', { file_path: '/x.ts', offset: 0, limit: 10 });
      const withoutOffset = formatToolProgress('Read', { file_path: '/x.ts', limit: 10 });
      expect(typeof withZero).toBe('string');
      expect(typeof withoutOffset).toBe('string');
      expect(withZero).toContain('x.ts');
    });

    it('formats Read with both offset and limit', () => {
      const msg = formatToolProgress('Read', { file_path: 'main.ts', offset: 10, limit: 20 });
      expect(msg).toContain('main.ts');
      expect(msg).toMatch(/10/);
      expect(msg).toMatch(/\d+-\d+|10.*20/);
    });

    it('formats Read with empty file_path', () => {
      expect(() => formatToolProgress('Read', { file_path: '' })).not.toThrow();
    });

    it('formats Read with missing file_path (no key at all)', () => {
      expect(() => formatToolProgress('Read', {})).not.toThrow();
    });
  });

  describe('Edit edge cases', () => {
    it('formats Edit with empty old_string', () => {
      const msg = formatToolProgress('Edit', {
        file_path: 'target.ts',
        old_string: '',
        new_string: 'replacement',
      });
      expect(msg).toContain('target.ts');
      expect(() => formatToolProgress('Edit', { file_path: 'target.ts', old_string: '', new_string: 'x' })).not.toThrow();
    });

    it('formats Edit with empty new_string', () => {
      const msg = formatToolProgress('Edit', {
        file_path: 'target.ts',
        old_string: 'old content',
        new_string: '',
      });
      expect(msg).toContain('target.ts');
      expect(() => formatToolProgress('Edit', { file_path: 'target.ts', old_string: 'x', new_string: '' })).not.toThrow();
    });

    it('formats Edit with both old_string and new_string empty', () => {
      expect(() => formatToolProgress('Edit', {
        file_path: 'f.ts',
        old_string: '',
        new_string: '',
      })).not.toThrow();
    });

    it('formats Edit when file_path is missing', () => {
      expect(() => formatToolProgress('Edit', { old_string: 'x', new_string: 'y' })).not.toThrow();
    });

    it('truncates long old_string in Edit display', () => {
      const longOld = 'X'.repeat(200);
      const msg = formatToolProgress('Edit', {
        file_path: 'big.ts',
        old_string: longOld,
        new_string: 'replacement',
      });
      expect(msg.length).toBeLessThan(300);
    });
  });

  describe('Bash edge cases', () => {
    it('formats Bash with empty command AND no description', () => {
      const msg = formatToolProgress('Bash', { command: '' });
      expect(typeof msg).toBe('string');
      expect(() => formatToolProgress('Bash', { command: '' })).not.toThrow();
    });

    it('formats Bash with no input fields at all', () => {
      expect(() => formatToolProgress('Bash', {})).not.toThrow();
    });

    it('truncates Bash description when it exceeds limit', () => {
      const longDesc = 'D'.repeat(200);
      const msg = formatToolProgress('Bash', { command: 'ls', description: longDesc });
      expect(msg.length).toBeLessThan(300);
      expect(msg).toMatch(/^Bash\(/);
    });

    it('truncates Bash command when no description and command is long', () => {
      const longCmd = 'find /home -name "*.ts" -exec grep -l "import" {} \\; | sort | uniq -c | sort -rn | head -20';
      const msg = formatToolProgress('Bash', { command: longCmd });
      expect(msg.length).toBeLessThan(300);
      expect(msg).toMatch(/^Bash\(/);
    });

    it('prefers description over command when both present', () => {
      const msg = formatToolProgress('Bash', {
        command: 'ls -la /some/path',
        description: 'List directory contents',
      });
      expect(msg).toContain('List directory contents');
    });
  });

  describe('Grep edge cases', () => {
    it('formats Grep with only pattern (no path)', () => {
      const msg = formatToolProgress('Grep', { pattern: 'TODO' });
      expect(msg).toBe('Grep(TODO)');
    });

    it('formats Grep with empty pattern', () => {
      expect(() => formatToolProgress('Grep', { pattern: '' })).not.toThrow();
    });

    it('formats Grep with missing pattern', () => {
      expect(() => formatToolProgress('Grep', {})).not.toThrow();
    });
  });

  describe('Glob edge cases', () => {
    it('formats Glob with only pattern (no path)', () => {
      const msg = formatToolProgress('Glob', { pattern: '**/*.ts' });
      expect(msg).toBe('Glob(**/*.ts)');
    });

    it('formats Glob with empty pattern', () => {
      expect(() => formatToolProgress('Glob', { pattern: '' })).not.toThrow();
    });
  });

  describe('Write edge cases', () => {
    it('formats Write with deep path — shows only basename', () => {
      const msg = formatToolProgress('Write', {
        file_path: '/very/deep/nested/path/to/output.ts',
        content: 'file content',
      });
      expect(msg).toBe('Write(output.ts)');
    });

    it('formats Write with missing file_path', () => {
      expect(() => formatToolProgress('Write', { content: 'hello' })).not.toThrow();
    });
  });

  describe('Agent edge cases', () => {
    it('formats Agent with missing description field', () => {
      expect(() => formatToolProgress('Agent', {})).not.toThrow();
    });

    it('truncates long Agent description', () => {
      const longDesc = 'A'.repeat(200);
      const msg = formatToolProgress('Agent', { description: longDesc });
      expect(msg.length).toBeLessThan(300);
      expect(msg).toMatch(/^Agent\(/);
    });
  });

  describe('fallback for unknown tool names', () => {
    it('returns "Using: <name>" for unknown tool', () => {
      const msg = formatToolProgress('MyCustomTool', { arg: 'val' });
      expect(msg).toContain('MyCustomTool');
    });

    it('handles empty tool name for fallback', () => {
      expect(() => formatToolProgress('', {})).not.toThrow();
    });
  });

  describe('non-string file_path values', () => {
    it('handles null file_path for Read without crashing', () => {
      expect(() => formatToolProgress('Read', { file_path: null as unknown as string })).not.toThrow();
    });

    it('handles numeric file_path for Edit without crashing', () => {
      expect(() => formatToolProgress('Edit', {
        file_path: 42 as unknown as string,
        old_string: 'x',
        new_string: 'y',
      })).not.toThrow();
    });
  });
});
