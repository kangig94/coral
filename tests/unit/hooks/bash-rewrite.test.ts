import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASH_REWRITE_HOOK,
  cleanupFixtures,
  createFixture,
  expectBashRewriteOutput,
  extractTempInputPaths,
  liveWorkBackgroundDir,
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

  it('keeps the rewrite enveloped under Copilot, which ignores a top-level updatedInput', () => {
    const fixture = createFixture();
    const command = 'coral-cli kb search foo';

    const result = runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: fixture.projectRoot,
        tool_input: { command },
      },
      { COPILOT_PLUGIN_ROOT: fixture.pluginRoot },
    );

    expect(result.status).toBe(0);

    // Copilot's envelope rule is per-field, not global: `additionalContext` is
    // read only at the top level, but `permissionDecision`/`updatedInput` are
    // read only inside `hookSpecificOutput` (A/B-verified on Copilot 1.0.78 —
    // a flat updatedInput leaves the original command running). Hoisting these
    // would silently disable every coral-cli rewrite under Copilot.
    const output = expectBashRewriteOutput(result);
    expect(output.hookSpecificOutput.updatedInput.command).toBe(expectedRewrittenCommand(command));
    const flat = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(flat.updatedInput).toBeUndefined();
    expect(flat.permissionDecision).toBeUndefined();
  });

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

  it('creates inline-text spill files readable only by the owner', () => {
    const fixture = createFixture();
    const preloadPath = join(fixture.root, 'zero-umask.cjs');
    writeFileSync(preloadPath, 'process.umask(0);\n', 'utf-8');

    const result = runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: fixture.projectRoot,
        tool_input: { command: 'coral-cli codex agent -i "private prompt"' },
      },
      { NODE_OPTIONS: `--require=${preloadPath}`, TMPDIR: fixture.tmpRoot },
    );

    expect(result.status).toBe(0);

    expectBashRewriteOutput(result);
    const tempInputs = readdirSync(fixture.tmpRoot).filter((name) => /^coral-input-[0-9a-f]{16}\.txt$/.test(name));

    expect(tempInputs).toHaveLength(1);
    expect(statSync(join(fixture.tmpRoot, tempInputs[0])).mode & 0o777).toBe(0o600);
  });

  it('fails open without writing through a pre-existing inline-text symlink', () => {
    const fixture = createFixture();
    const id = '0011223344556677';
    const targetPath = join(fixture.root, 'symlink-target.txt');
    const spillPath = join(fixture.tmpRoot, `coral-input-${id}.txt`);
    const preloadPath = join(fixture.root, 'fixed-random-bytes.cjs');
    const prompt = 'must not reach the symlink target';

    writeFileSync(targetPath, 'sentinel', 'utf-8');
    symlinkSync(targetPath, spillPath);
    writeFileSync(
      preloadPath,
      [
        "const crypto = require('node:crypto');",
        "const { syncBuiltinESMExports } = require('node:module');",
        `crypto.randomBytes = () => Buffer.from('${id}', 'hex');`,
        'syncBuiltinESMExports();',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: fixture.projectRoot,
        tool_input: { command: `coral-cli codex agent -i "${prompt}"` },
      },
      { NODE_OPTIONS: `--require=${preloadPath}`, TMPDIR: fixture.tmpRoot },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(targetPath, 'utf-8')).toBe('sentinel');
    expect(result.stdout).toBe('');
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

  it('injects a fixed Bash timeout for wait commands without forcing foreground', () => {
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
    expect(updatedInput.run_in_background).toBeUndefined();
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
    expect(updatedInput.run_in_background).toBeUndefined();
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
    expect(updatedInput.run_in_background).toBeUndefined();
  });
});

describe('bash-rewrite.mjs: background-task wrapping', () => {
  const cliBundle = join(process.cwd(), 'clients', 'bridge', 'coral-cli.cjs');
  const SESSION = 'sess-bgwrap-01';

  function bgDir(fixture: HookFixture): string {
    return liveWorkBackgroundDir(fixture, SESSION);
  }

  function runBg(fixture: HookFixture, toolInput: Record<string, unknown>) {
    return runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: SESSION,
        cwd: fixture.projectRoot,
        tool_input: toolInput,
      },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );
  }

  it('wraps a run_in_background command and records .launched', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'npm run build', run_in_background: true });

    const rewritten = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput.command;
    expect(rewritten).toContain('coral-work');
    expect(rewritten).toContain('.lock');
    expect(rewritten.endsWith('npm run build')).toBe(true);
    expect(readdirSync(bgDir(fixture)).some((name) => name.endsWith('.launched'))).toBe(true);
  });

  it('leaves a foreground command untouched', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'npm run build', run_in_background: false });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('tracks a backgrounded coral-cli wait like any other background command', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'coral-cli wait --jobs abc123', run_in_background: true });

    const updatedInput = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.run_in_background).toBe(true);
    expect(updatedInput.timeout).toBe(600_000);
    expect(updatedInput.command).toContain('coral-work');
  });

  it('both resolves coral-cli and wraps when backgrounded', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'coral-cli kb search q', run_in_background: true });

    const rewritten = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput.command;
    expect(rewritten).toContain(`node "${cliBundle}" kb search q`);
    expect(rewritten).toContain('coral-work');
    expect(rewritten.endsWith(`node "${cliBundle}" kb search q`)).toBe(true);
  });

  it('leaves a backgrounded command unwrapped when session_id is absent', () => {
    const fixture = createFixture();
    const result = runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: fixture.projectRoot,
        tool_input: { command: 'npm run build', run_in_background: true },
      },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('resolves coral-cli but does not wrap when session_id is absent', () => {
    const fixture = createFixture();
    const result = runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        cwd: fixture.projectRoot,
        tool_input: { command: 'coral-cli kb search q', run_in_background: true },
      },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );

    const updatedInput = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.command).toContain(`node "${cliBundle}" kb search q`);
    expect(updatedInput.command).not.toContain('coral-work');
    expect(updatedInput.run_in_background).toBe(true);
  });
});
