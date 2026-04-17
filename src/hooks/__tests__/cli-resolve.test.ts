import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLI_RESOLVE_HOOK,
  cleanupFixtures,
  createFixture,
  expectCliResolveOutput,
  extractTempInputPaths,
  parseJsonOutput,
  runHook,
} from './_helpers.js';

afterEach(cleanupFixtures);

describe('cli-resolve.mjs', () => {
  const cliBundle = join(process.cwd(), 'bridge', 'coral-cli.cjs');
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

  it('extracts provider -i quoted text to a temp file, skips top-level --output-format, and leaves provider -s untouched', () => {
    const fixture = createFixture();
    const command = 'coral-cli --output-format json codex -s session-1 -i "text with $HOME and `backticks`"';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain(`node "${cliBundle}" --output-format json codex`);
    expect(rewritten).toContain('-s session-1');
    expect(rewritten).not.toContain('text with $HOME and `backticks`');
    expect(tempPaths).toHaveLength(1);
    expect(existsSync(tempPaths[0])).toBe(true);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('text with $HOME and `backticks`');
  });

  it('extracts workflow -s and -c text with mixed quote forms while skipping top-level -f', () => {
    const fixture = createFixture();
    const command = 'coral-cli -f json workflow architect -s\'start prompt\' --context="ctx \\\"quoted\\\""';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain(`node "${cliBundle}" -f json workflow architect`);
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths.map((filePath) => readFileSync(filePath, 'utf-8'))).toEqual([
      'start prompt',
      'ctx "quoted"',
    ]);
  });

  it('preserves quoted existing file paths for provider -i relative to input.cwd', () => {
    const fixture = createFixture();
    const promptsDir = join(fixture.projectRoot, 'prompts');
    const promptPath = join(promptsDir, 'alpha prompt.md');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(promptPath, '# prompt', 'utf-8');

    const command = 'coral-cli codex -i "./prompts/alpha prompt.md"';
    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
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

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
    expect(extractTempInputPaths(rewritten)).toHaveLength(0);
  });

  it('wraps unquoted tokens containing parentheses in single quotes after rewriting the quoted prompt', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i "hello" func(x)';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
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

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
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

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(rewritten).toContain(`'${orphanToken}'`);
  });

  it('leaves tokens without shell metacharacters untouched', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i hello world';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
  });

  it('preserves the workflow -e expression with parens inside double quotes', () => {
    const fixture = createFixture();
    const command = 'coral-cli workflow -e "(a,b)" -s "do thing" -c "ctx"';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain('-e "(a,b)"');
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths.map((filePath) => readFileSync(filePath, 'utf-8')).sort()).toEqual(['ctx', 'do thing']);
  });

  it('forces timeout and run_in_background on wait commands with explicit --timeout', () => {
    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli wait --jobs jb-1 --timeout 30' },
    });

    const output = expectCliResolveOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBe(40_000);
    expect(updatedInput.run_in_background).toBe(false);
  });

  it('forces default timeout on wait commands without --timeout flag', () => {
    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli wait --jobs jb-1' },
    });

    const output = expectCliResolveOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    // The default wait timeout is 600s; with +10s margin the computed value is
    // 610_000ms, but the Bash tool caps timeout at 600_000ms.
    expect(updatedInput.timeout).toBe(600_000);
    expect(updatedInput.run_in_background).toBe(false);
  });

  it('does not force timeout on non-wait commands', () => {
    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli codex architect -i "plan this"' },
    });

    const output = expectCliResolveOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBeUndefined();
    expect(updatedInput.run_in_background).toBeUndefined();
  });

  it('splits && chains and processes each coral-cli segment independently', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i "hello" && echo done';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('hello');
    expect(rewritten).toContain(`node "${cliBundle}" codex agent -i `);
    expect(rewritten.endsWith(' && echo done')).toBe(true);
  });

  it('rewrites the coral-cli stage of a pipeline and leaves the rest intact', () => {
    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli kb principles | grep foo' },
    });

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(`node "${cliBundle}" kb principles | grep foo`);
  });

  it('treats a DQ-contained && as literal and does not split', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i "a && b"';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('a && b');
  });

  it('rewrites a stale bridge path under the coral plugin cache to the active bridge', () => {
    const cacheRoot = join(process.cwd(), '..');
    const stale = join(cacheRoot, '0.0.0-nonexistent', 'bridge', 'coral-cli.cjs');
    expect(existsSync(stale)).toBe(false);

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `node "${stale}" kb principles` },
    });

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(`node "${cliBundle}" kb principles`);
  });

  it('leaves an external --plugin-dir bridge path untouched', () => {
    const external = '/tmp/does-not-exist-xyz-coral/bridge/coral-cli.cjs';
    expect(existsSync(external)).toBe(false);

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `node "${external}" kb principles` },
    });

    // Outside the coral cache prefix → no rewrite, no wait policy → silent pass-through.
    expect(result.status).toBe(0);
    expect(parseJsonOutput<unknown>(result.stdout)).toBeNull();
  });

  it('is idempotent: bare coral-cli → node "<active>" has no further change', () => {
    const first = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli kb principles' },
    });
    const rewritten = expectCliResolveOutput(first).hookSpecificOutput.updatedInput.command;

    const second = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: rewritten },
    });

    expect(second.status).toBe(0);
    expect(parseJsonOutput<unknown>(second.stdout)).toBeNull();
  });

  it('caps Bash timeout at 600_000ms even for wait --timeout=600', () => {
    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli wait --jobs jb-1 --timeout 600' },
    });

    const output = expectCliResolveOutput(result);
    const updatedInput = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBe(600_000);
  });
});
