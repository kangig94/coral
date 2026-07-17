import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASH_REWRITE_HOOK,
  cleanupFixtures,
  createFixture,
  expectBashRewriteOutput,
  extractTempInputPaths,
  parseJsonOutput,
  runHook,
  type HookFixture,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

describe('bash-rewrite.mjs', () => {
  const cliBundle = join(process.cwd(), 'clients', 'bridge', 'coral-cli.cjs');
  const createdTempInputs: string[] = [];

  afterEach(() => {
    for (const filePath of createdTempInputs.splice(0)) {
      rmSync(filePath, { force: true });
    }
  });

  function rememberTempInputs(command: string): string[] {
    const tempPaths = extractTempInputPaths(command);
    createdTempInputs.push(...tempPaths);
    return tempPaths;
  }

  function expectedRewrittenCommand(command: string): string {
    return command.replace(/^(\s*)coral-cli(\s|$)(.*)$/s, `$1node "${cliBundle}"$2$3`);
  }

  it('leaves invalid top-level -f untouched for Commander to reject at parse time', () => {
    const fixture = createFixture();
    const command = 'coral-cli -f json codex -i "text with $HOME and `backticks`"';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    // -f json stays before codex so Commander rejects the unknown top-level flag.
    expect(rewritten).toContain('-f json codex');
    // The hook bails out of inline rewriting when a non-KB leading flag is present,
    // so the raw -i text stays in the command. Commander will surface the parse error.
    expect(rewritten).toContain('text with $HOME and `backticks`');
  });

  it('extracts workflow -s and -c text with mixed quote forms', () => {
    const fixture = createFixture();
    const command = 'coral-cli workflow -e architect -s\'start prompt\' --context="ctx \\\"quoted\\\""';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain(`node "${cliBundle}" workflow -e architect`);
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths.map((filePath) => readFileSync(filePath, 'utf-8'))).toEqual(['start prompt', 'ctx "quoted"']);
  });

  it('preserves kb-local -f json during rewrite', () => {
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli kb search q -f json' },
    });

    const output = expectBashRewriteOutput(result);
    expect(output.hookSpecificOutput.updatedInput.command).toBe(`node "${cliBundle}" kb search q -f json`);
  });

  it('preserves kb-local --output-format json during rewrite', () => {
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli kb search q --output-format json' },
    });

    const output = expectBashRewriteOutput(result);
    expect(output.hookSpecificOutput.updatedInput.command).toBe(`node "${cliBundle}" kb search q --output-format json`);
  });

  it('preserves quoted existing file paths for provider -i relative to input.cwd', () => {
    const fixture = createFixture();
    const promptsDir = join(fixture.projectRoot, 'prompts');
    const promptPath = join(promptsDir, 'alpha prompt.md');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(promptPath, '# prompt', 'utf-8');

    const command = 'coral-cli codex -i "./prompts/alpha prompt.md"';
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
    expect(rewritten).toContain('"./prompts/alpha prompt.md"');
    expect(extractTempInputPaths(rewritten)).toHaveLength(0);
  });

  it.each([
    ['unquoted expansion', 'coral-cli codex -i $HOME/prompt.md'],
    ['ambiguous short cluster', 'coral-cli codex -bi "prompt"'],
    ['unquoted backslash-escaped literal', 'coral-cli codex -i hello\\ world'],
    ['unterminated quoting', 'coral-cli codex -i "unterminated'],
  ])('fails open for %s', (_label, command) => {
    const fixture = createFixture();

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
    expect(extractTempInputPaths(rewritten)).toHaveLength(0);
  });

  it('wraps unquoted tokens containing parentheses in single quotes after rewriting the quoted prompt', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i "hello" func(x)';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('hello');
    expect(rewritten).toContain("'func(x)'");
    expect(rewritten).not.toMatch(/\sfunc\(x\)(\s|$)/);
  });

  it('wraps unquoted parenthesized tokens even when the -i value itself is unquoted', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i Check func(x)';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(extractTempInputPaths(rewritten)).toHaveLength(0);
    expect(rewritten).toContain(' -i Check ');
    expect(rewritten).toContain("'func(x)'");
  });

  it.each([
    ['square brackets', 'arr[0]'],
    ['curly braces', '{a,b}'],
    ['mixed brackets and parens', 'fn(x)[0]'],
  ])('wraps unquoted tokens containing %s after a quoted -i value', (_label, orphanToken) => {
    const fixture = createFixture();
    const command = `coral-cli codex agent -i "hello" ${orphanToken}`;

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(rewritten).toContain(`'${orphanToken}'`);
  });

  it('leaves tokens without shell metacharacters untouched', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i hello world';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
  });

  it('preserves the workflow -e expression with parens inside double quotes', () => {
    const fixture = createFixture();
    const command = 'coral-cli workflow -e "(a,b)" -s "do thing" -c "ctx"';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain('-e "(a,b)"');
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths.map((filePath) => readFileSync(filePath, 'utf-8')).sort()).toEqual(['ctx', 'do thing']);
  });

  it('forces fixed timeout and run_in_background on wait commands', () => {
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli wait jobs jb-1' },
    });

    const output = expectBashRewriteOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    // Fixed Bash ceiling; wait CLI emits its final event at 590s so the
    // process flushes and exits before the 600_000ms kill.
    expect(updatedInput.timeout).toBe(600_000);
    expect(updatedInput.run_in_background).toBe(false);
  });

  it('does not force timeout on non-wait commands', () => {
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli codex architect -i "plan this"' },
    });

    const output = expectBashRewriteOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBeUndefined();
    expect(updatedInput.run_in_background).toBeUndefined();
  });

  it('splits && chains and processes each coral-cli segment independently', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i "hello" && echo done';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('hello');
    expect(rewritten).toContain(`node "${cliBundle}" codex agent -i `);
    expect(rewritten.endsWith(' && echo done')).toBe(true);
  });

  it('rewrites the coral-cli stage of a pipeline and leaves the rest intact', () => {
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli kb principles | grep foo' },
    });

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(`node "${cliBundle}" kb principles | grep foo`);
  });

  it('treats a DQ-contained && as literal and does not split', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i "a && b"';

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('a && b');
  });

  it('rewrites a stale bridge path under the coral plugin cache to the active bridge', () => {
    const cacheRoot = process.cwd();
    const stale = join(cacheRoot, '0.0.0-nonexistent', 'bridge', 'coral-cli.cjs');
    expect(existsSync(stale)).toBe(false);

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `node "${stale}" kb principles` },
    });

    const output = expectBashRewriteOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(`node "${cliBundle}" kb principles`);
  });

  it('leaves an external --plugin-dir bridge path untouched', () => {
    const external = '/tmp/does-not-exist-xyz-coral/bridge/coral-cli.cjs';
    expect(existsSync(external)).toBe(false);

    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `node "${external}" kb principles` },
    });

    // Outside the coral cache prefix → no rewrite, no wait policy → silent pass-through.
    expect(result.status).toBe(0);
    expect(parseJsonOutput<unknown>(result.stdout)).toBeNull();
  });

  it('is idempotent: bare coral-cli → node "<active>" has no further change', () => {
    const first = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli kb principles' },
    });
    const rewritten = expectBashRewriteOutput(first).hookSpecificOutput.updatedInput.command;

    const second = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: rewritten },
    });

    expect(second.status).toBe(0);
    expect(parseJsonOutput<unknown>(second.stdout)).toBeNull();
  });

  it('injects Bash timeout for coral-cli wait even when the command has shell redirection', () => {
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: `node "${cliBundle}" wait jobs jb-1 --embed > /tmp/out.txt 2>&1`,
      },
    });

    const output = expectBashRewriteOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBe(600_000);
    expect(updatedInput.run_in_background).toBe(false);
  });

  it('injects Bash timeout when wait is part of a compound command with $? expansion', () => {
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: `node "${cliBundle}" wait jobs jb-1 > /tmp/out.jsonl 2>&1; echo "exit=$?"`,
      },
    });

    const output = expectBashRewriteOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBe(600_000);
    expect(updatedInput.run_in_background).toBe(false);
  });
});

describe('bash-rewrite.mjs: background-task wrapping', () => {
  const cliBundle = join(process.cwd(), 'clients', 'bridge', 'coral-cli.cjs');
  const SESSION = 'sess-bgwrap-01';

  function bgDir(fixture: HookFixture): string {
    const slug = fixture.projectRoot.replace(/\//g, '-');
    return join(fixture.workRoot, 'coral-work', slug, SESSION, 'bg');
  }

  function runBg(fixture: HookFixture, toolInput: Record<string, unknown>) {
    return runHook(
      BASH_REWRITE_HOOK,
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: SESSION, cwd: fixture.projectRoot, tool_input: toolInput },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );
  }

  it('wraps a run_in_background command and records .launched', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'npm run build', run_in_background: true });

    const rewritten = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput.command;
    expect(rewritten).toContain('coral-work'); // registry path baked into the wrapper
    expect(rewritten).toContain('.lock');
    expect(rewritten.endsWith('npm run build')).toBe(true); // original command preserved as the tail
    expect(readdirSync(bgDir(fixture)).some((name) => name.endsWith('.launched'))).toBe(true);
  });

  it('leaves a foreground command untouched', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'npm run build', run_in_background: false });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(''); // no rewrite emitted
  });

  it('does not wrap coral-cli wait even when backgrounded (forced foreground)', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'coral-cli wait --jobs abc123', run_in_background: true });

    const updatedInput = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.run_in_background).toBe(false); // forced foreground
    expect(updatedInput.command).not.toContain('coral-work'); // not wrapped
  });

  it('both resolves coral-cli and wraps when backgrounded', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'coral-cli kb search q', run_in_background: true });

    const rewritten = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput.command;
    expect(rewritten).toContain(`node "${cliBundle}" kb search q`); // coral resolved
    expect(rewritten).toContain('coral-work'); // and wrapped
    expect(rewritten.endsWith(`node "${cliBundle}" kb search q`)).toBe(true); // resolved command is the tail
  });

  it('leaves a backgrounded command unwrapped when session_id is absent', () => {
    const fixture = createFixture();
    const result = runHook(
      BASH_REWRITE_HOOK,
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: fixture.projectRoot, tool_input: { command: 'npm run build', run_in_background: true } },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(''); // no session ⇒ no wrap; no coral change ⇒ no output
  });

  it('resolves coral-cli but does not wrap when session_id is absent', () => {
    const fixture = createFixture();
    const result = runHook(
      BASH_REWRITE_HOOK,
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: fixture.projectRoot, tool_input: { command: 'coral-cli kb search q', run_in_background: true } },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );

    const updatedInput = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.command).toContain(`node "${cliBundle}" kb search q`); // coral resolved
    expect(updatedInput.command).not.toContain('coral-work'); // not wrapped (no session)
    expect(updatedInput.run_in_background).toBe(true); // preserved
  });
});
