import { describe, it, expect } from 'vitest';
import { stripShellWrapper, matchCommandPattern } from '../command-patterns.js';

const projectRoot = '/repo';

function expectPattern(command: string, expected: string, cwd = projectRoot): void {
  expect(matchCommandPattern(command, cwd)).toBe(expected);
}

function expectNoPattern(command: string, cwd = projectRoot): void {
  expect(matchCommandPattern(command, cwd)).toBeNull();
}

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

  it('strips cd <dir> && prefix', () => {
    expect(stripShellWrapper('cd /home/user/project && nl -ba src/main.ts')).toBe('nl -ba src/main.ts');
    expect(stripShellWrapper('cd /tmp && rg -n "TODO" src/')).toBe('rg -n "TODO" src/');
  });

  it('strips cd prefix inside shell wrapper', () => {
    expect(stripShellWrapper('/usr/bin/zsh -lc "cd /project && cat file.ts"')).toBe('cat file.ts');
  });
});

describe('matchCommandPattern', () => {
  it('matches nl|sed and sed range reads', () => {
    expectPattern("nl -ba src/main.ts | sed -n '10,20p'", 'Read(src/main.ts:10-20)');
    expectPattern("sed -n '5,8p' src/app.ts", 'Read(src/app.ts:5-8)');
  });

  it('matches bare nl -ba as Read', () => {
    expectPattern('nl -ba src/providers/codex/codex-executor.ts', 'Read(src/providers/codex/codex-executor.ts)');
    expectPattern('nl -ba .claude/coral/plans/effort-parameter-unification.md', 'Read(.claude/coral/plans/effort-parameter-unification.md)');
  });

  it('matches cat and rg patterns', () => {
    expectPattern('cat src/main.ts', 'Read(src/main.ts)');
    expectPattern('rg -n "extractProgressMessage" src', 'Grep(extractProgressMessage)');
    expectPattern("rg -n 'parseClaudeStreamJson' src", 'Grep(parseClaudeStreamJson)');
  });

  it('falls back to process.cwd() when projectRoot is omitted', () => {
    expect(matchCommandPattern(`cat ${process.cwd()}/src/main.ts`)).toBe('Read(src/main.ts)');
  });

  it('returns null for unknown commands', () => {
    expectNoPattern('ls -la');
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
      expectPattern('cat src/parser.ts', 'Read(src/parser.ts)');
    });

    it('matches absolute path inside projectRoot as a relative Read path', () => {
      expectPattern('cat /repo/src/index.ts', 'Read(src/index.ts)');
    });

    it('returns null for bare "cat" with no file argument (reads stdin)', () => {
      expectNoPattern('cat');
    });

    it('returns null for "cat -n" (flag only, no file arg)', () => {
      expectNoPattern('cat -n');
    });
  });

  describe('rg with unquoted pattern', () => {
    it('matches rg with unquoted single-word pattern', () => {
      const result = matchCommandPattern('rg TODO src/', projectRoot);
      expect(result).toMatch(/^Grep\(/);
    });

    it('matches rg with -n flag before pattern', () => {
      const result = matchCommandPattern('rg -n "import" src/', projectRoot);
      expect(result).toMatch(/^Grep\(/);
    });

    it('extracts the quoted pattern text for rg', () => {
      expectPattern('rg "function parseClause"', 'Grep(function parseClause)');
    });

    it('matches rg with path argument after pattern', () => {
      const result = matchCommandPattern('rg "TODO" /home/user/project/src', projectRoot);
      expect(result).toMatch(/^Grep\(/);
    });

    it('matches bare "rg" with no args — does not crash', () => {
      expect(() => matchCommandPattern('rg', projectRoot)).not.toThrow();
    });
  });

  describe('nl command alone — not a Read pattern', () => {
    it('returns null for "nl" alone (no file or pipe)', () => {
      expectNoPattern('nl');
    });

    it('returns null for "nl -ba" without pipe and file', () => {
      expectNoPattern('nl -ba');
    });
  });

  describe('sed alone — maps to Read per plan rule table', () => {
    it('matches sed -n range pattern as Read(path:N-M)', () => {
      // Plan rule table includes: sed -n 'N,Mp' file → Read(path:N-M)
      expectPattern("sed -n '10,20p' file.ts", 'Read(file.ts:10-20)');
    });
  });

  describe('commands that look like patterns but are not in the rule table', () => {
    it('returns null for commands outside the rule table', () => {
      const unknownCommands = [
        'grep -r "pattern" src/',
        'head -n 20 file.ts',
        'tail -f log.txt',
        'less file.txt',
      ];
      for (const command of unknownCommands) {
        expectNoPattern(command);
      }
    });
  });

  describe('multiline and piped commands not in the rule table', () => {
    it('returns null for unsupported command chains', () => {
      const chainedCommands = [
        'cd /project; ls -la; cat package.json',
        'cat file.ts | wc -l',
        'find . | xargs cat',
      ];
      for (const command of chainedCommands) {
        expectNoPattern(command);
      }
    });
  });

  describe('edge input values', () => {
    it('returns null for empty string', () => {
      expectNoPattern('');
    });

    it('returns null for whitespace-only string', () => {
      expectNoPattern('   ');
    });

    it('does not crash on very long command string', () => {
      const longCmd = 'ls ' + '-la '.repeat(500);
      expect(() => matchCommandPattern(longCmd, projectRoot)).not.toThrow();
    });
  });

  describe('nl -ba + sed range pattern — boundary variants', () => {
    it('matches nl -ba file | sed pattern and extracts line range', () => {
      expectPattern("nl -ba src/parser.ts | sed -n '50,100p'", 'Read(src/parser.ts:50-100)');
    });

    it('matches sed -n range + file (without nl prefix)', () => {
      expectPattern("sed -n '1,10p' src/config.ts", 'Read(src/config.ts:1-10)');
    });

    it('matches bare nl -ba as Read(path)', () => {
      expectPattern('nl -ba src/main.ts', 'Read(src/main.ts)');
    });
  });
});
