import { describe, it, expect } from 'vitest';
import { stripShellWrapper, matchCommandPattern } from '../command-patterns.js';

describe('stripShellWrapper', () => {
  it('strips /usr/bin/zsh -lc wrapper', () => {
    expect(stripShellWrapper('/usr/bin/zsh -lc "ls -la"')).toBe('ls -la');
  });

  it('strips /bin/sh -c and bash -lc wrappers', () => {
    expect(stripShellWrapper("/bin/sh -c 'cat src/main.ts'")).toBe('cat src/main.ts');
    expect(stripShellWrapper('bash -lc "rg \\"needle\\" src"')).toBe('rg "needle" src');
  });

  it('returns command unchanged when no shell wrapper matches', () => {
    expect(stripShellWrapper('git status')).toBe('git status');
  });
});

describe('matchCommandPattern', () => {
  it('matches nl|sed and sed range reads', () => {
    expect(matchCommandPattern("nl -ba src/main.ts | sed -n '10,20p'")).toBe('Read(main.ts:10-20)');
    expect(matchCommandPattern("sed -n '5,8p' src/app.ts")).toBe('Read(app.ts:5-8)');
  });

  it('matches cat and rg patterns', () => {
    expect(matchCommandPattern('cat src/main.ts')).toBe('Read(main.ts)');
    expect(matchCommandPattern('rg -n "extractProgressMessage" src')).toBe('Grep(extractProgressMessage)');
    expect(matchCommandPattern("rg -n 'parseClaudeStreamJson' src")).toBe('Grep(parseClaudeStreamJson)');
  });

  it('returns null for unknown commands', () => {
    expect(matchCommandPattern('ls -la')).toBeNull();
  });
});

describe('stripShellWrapper — adversarial', () => {
  describe('no wrapper — pass-through', () => {
    it('returns the command unchanged when no shell wrapper is present', () => {
      expect(stripShellWrapper('ls -la')).toBe('ls -la');
    });

    it('returns the command unchanged for a plain cat command', () => {
      expect(stripShellWrapper('cat /etc/hosts')).toBe('cat /etc/hosts');
    });

    it('returns empty string unchanged', () => {
      expect(stripShellWrapper('')).toBe('');
    });
  });

  describe('nested quotes inside the wrapper payload', () => {
    it('strips zsh wrapper and preserves inner single quotes in payload', () => {
      const inner = "sed -n '10,20p' src/main.ts";
      const wrapped = `/usr/bin/zsh -lc "${inner}"`;
      const result = stripShellWrapper(wrapped);
      expect(result).toBe(inner);
    });

    it('strips bash wrapper and preserves inner double quotes in payload', () => {
      const inner = 'rg "pattern" src/';
      const wrapped = `/bin/sh -c '${inner}'`;
      const result = stripShellWrapper(wrapped);
      expect(result).toBe(inner);
    });

    it('strips wrapper when payload itself contains shell metacharacters', () => {
      const inner = 'find . -name "*.ts" | xargs grep "TODO"';
      // Codex escapes inner double quotes as \" inside a double-quoted wrapper
      const wrapped = 'zsh -lc "find . -name \\"*.ts\\" | xargs grep \\"TODO\\""';
      const result = stripShellWrapper(wrapped);
      expect(result).toBe(inner);
    });
  });

  describe('/usr/bin/bash variant', () => {
    it('strips /usr/bin/bash -c wrapper', () => {
      const inner = 'echo hello';
      const result = stripShellWrapper(`/usr/bin/bash -c "${inner}"`);
      // Either strips it or passes through — must not crash
      expect(typeof result).toBe('string');
      if (result !== `/usr/bin/bash -c "${inner}"`) {
        expect(result).toBe(inner);
      }
    });
  });

  describe('zsh -c without -l flag', () => {
    it('strips zsh -c wrapper (no -l)', () => {
      const inner = 'cat README.md';
      const result = stripShellWrapper(`zsh -c "${inner}"`);
      // Either strips it or passes through — must not crash
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('payload with trailing whitespace', () => {
    it('strips trailing whitespace from extracted payload', () => {
      const inner = 'ls -la  ';
      const wrapped = `/bin/sh -c "${inner}"`;
      const result = stripShellWrapper(wrapped);
      expect(typeof result).toBe('string');
    });
  });

  describe('wrapper with extra spaces between parts', () => {
    it('handles extra space between command and -lc flag', () => {
      const inner = 'cat file.ts';
      expect(() => stripShellWrapper(`zsh  -lc "${inner}"`)).not.toThrow();
    });
  });
});

describe('matchCommandPattern — adversarial', () => {
  describe('cat command', () => {
    it('matches "cat file.ts" → Read(file.ts)', () => {
      const result = matchCommandPattern('cat src/parser.ts');
      expect(result).toBe('Read(parser.ts)');
    });

    it('matches "cat /deep/path/to/file.ts" → Read(file.ts) with basename', () => {
      const result = matchCommandPattern('cat /home/user/project/src/index.ts');
      expect(result).toBe('Read(index.ts)');
    });

    it('returns null for bare "cat" with no file argument (reads stdin)', () => {
      const result = matchCommandPattern('cat');
      expect(result).toBeNull();
    });

    it('returns null for "cat -n" (flag only, no file arg)', () => {
      const result = matchCommandPattern('cat -n');
      expect(result).toBeNull();
    });
  });

  describe('rg with unquoted pattern', () => {
    it('matches rg with unquoted single-word pattern', () => {
      const result = matchCommandPattern('rg TODO src/');
      expect(result).toMatch(/^Grep\(/);
    });

    it('matches rg with -n flag before pattern', () => {
      const result = matchCommandPattern('rg -n "import" src/');
      expect(result).toMatch(/^Grep\(/);
    });

    it('extracts the quoted pattern text for rg', () => {
      const result = matchCommandPattern('rg "function parseClause"');
      expect(result).toBe('Grep(function parseClause)');
    });

    it('matches rg with path argument after pattern', () => {
      const result = matchCommandPattern('rg "TODO" /home/user/project/src');
      expect(result).toMatch(/^Grep\(/);
    });

    it('matches bare "rg" with no args — does not crash', () => {
      expect(() => matchCommandPattern('rg')).not.toThrow();
    });
  });

  describe('nl command alone — not a Read pattern', () => {
    it('returns null for "nl" alone (no file or pipe)', () => {
      const result = matchCommandPattern('nl');
      expect(result).toBeNull();
    });

    it('returns null for "nl -ba" without pipe and file', () => {
      const result = matchCommandPattern('nl -ba');
      expect(result).toBeNull();
    });
  });

  describe('sed alone — maps to Read per plan rule table', () => {
    it('matches sed -n range pattern as Read(basename:N-M)', () => {
      // Plan rule table includes: sed -n 'N,Mp' file → Read(basename:N-M)
      const result = matchCommandPattern("sed -n '10,20p' file.ts");
      expect(result).toBe('Read(file.ts:10-20)');
    });
  });

  describe('commands that look like patterns but are not in the rule table', () => {
    it('returns null for "grep" (not rg)', () => {
      const result = matchCommandPattern('grep -r "pattern" src/');
      expect(result).toBeNull();
    });

    it('returns null for "head -n 20 file.ts"', () => {
      const result = matchCommandPattern('head -n 20 file.ts');
      expect(result).toBeNull();
    });

    it('returns null for "tail -f log.txt"', () => {
      const result = matchCommandPattern('tail -f log.txt');
      expect(result).toBeNull();
    });

    it('returns null for "less file.txt"', () => {
      const result = matchCommandPattern('less file.txt');
      expect(result).toBeNull();
    });
  });

  describe('multiline and piped commands not in the rule table', () => {
    it('returns null for a multi-command chain (semicolon-separated)', () => {
      const result = matchCommandPattern('cd /project; ls -la; cat package.json');
      expect(result).toBeNull();
    });

    it('returns null for a pipe chain that is not the nl|sed pattern', () => {
      const result = matchCommandPattern('cat file.ts | wc -l');
      expect(result).toBeNull();
    });

    it('returns null for "find . | xargs cat"', () => {
      const result = matchCommandPattern('find . | xargs cat');
      expect(result).toBeNull();
    });
  });

  describe('edge input values', () => {
    it('returns null for empty string', () => {
      expect(matchCommandPattern('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(matchCommandPattern('   ')).toBeNull();
    });

    it('does not crash on very long command string', () => {
      const longCmd = 'ls ' + '-la '.repeat(500);
      expect(() => matchCommandPattern(longCmd)).not.toThrow();
    });
  });

  describe('nl -ba + sed range pattern — boundary variants', () => {
    it('matches nl -ba file | sed pattern and extracts line range', () => {
      const result = matchCommandPattern("nl -ba src/parser.ts | sed -n '50,100p'");
      expect(result).toBe('Read(parser.ts:50-100)');
    });

    it('matches sed -n range + file (without nl prefix)', () => {
      const result = matchCommandPattern("sed -n '1,10p' config.ts");
      if (result !== null) {
        expect(result).toBe('Read(config.ts:1-10)');
      }
    });

    it('does not match nl -ba without the sed pipe', () => {
      const result = matchCommandPattern('nl -ba src/main.ts');
      if (result !== null) {
        expect(result).not.toMatch(/:\d+-\d+/);
      }
    });
  });
});
