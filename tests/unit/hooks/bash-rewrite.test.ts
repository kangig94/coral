import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASH_REWRITE_HOOK,
  cleanupFixtures,
  createFixture,
  expectBashRewriteOutput,
  liveWorkBackgroundDir,
  parseJsonOutput,
  runHook,
  type HookFixture,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

const BRIDGE_DIR = join(process.cwd(), 'clients', 'bridge');

function runBashHook(command: string, env: Record<string, string> = {}) {
  return runHook(BASH_REWRITE_HOOK, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, env);
}

function rewrittenCommand(command: string): string {
  return expectBashRewriteOutput(runBashHook(command)).hookSpecificOutput.updatedInput.command;
}

/** Splits the rewrite into the prefix the hook added and the command the shell will read after it. */
function splitPrefix(rewritten: string): { prefix: string; rest: string } {
  const newline = rewritten.indexOf('\n');
  return { prefix: rewritten.slice(0, newline), rest: rewritten.slice(newline + 1) };
}

describe('bash-rewrite.mjs', () => {
  it('keeps the rewrite enveloped under Copilot, which ignores a top-level updatedInput', () => {
    const fixture = createFixture();
    const result = runBashHook('coral-cli kb search foo', { COPILOT_PLUGIN_ROOT: fixture.pluginRoot });

    // Copilot's envelope rule is per-field, not global: `additionalContext` is
    // read only at the top level, but `permissionDecision`/`updatedInput` are
    // read only inside `hookSpecificOutput` (A/B-verified on Copilot 1.0.78 —
    // a flat updatedInput leaves the original command running). Hoisting these
    // would silently disable every coral-cli rewrite under Copilot.
    expect(expectBashRewriteOutput(result).hookSpecificOutput.updatedInput.command).toContain(
      'coral-cli kb search foo',
    );
    const flat = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(flat.updatedInput).toBeUndefined();
    expect(flat.permissionDecision).toBeUndefined();
  });

  it('puts the active bridge first on PATH for the command that follows', () => {
    const { prefix } = splitPrefix(rewrittenCommand('coral-cli kb principles'));

    const path = execFileSync('bash', ['-c', `${prefix}\nprintf %s "$PATH"`], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });

    expect(path).toBe(`${BRIDGE_DIR}:/usr/bin:/bin`);
  });

  it.each([
    [
      'a heredoc prompt with shell-sensitive text',
      "coral-cli codex architect -d -i - <<'CORAL_INPUT'\nread `$HOME` and $(pwd) (a && b) {x}\nCORAL_INPUT",
    ],
    ['a lone & in a redirection', 'coral-cli kb search q 2>&1 | head -5'],
    ['a chained invocation', 'cd "/tmp/x y" && coral-cli wait jobs jb-1 --embed; echo "exit=$?"'],
    ['a command substitution', 'job=$(coral-cli codex -d -i - <<<"$prompt")'],
    ['an env-prefixed, timed invocation', 'CORAL_DEBUG=1 time coral-cli kb search q'],
    ['a conditional', 'if coral-cli kb search q; then echo hit; fi'],
  ])('passes %s through byte-identical after the prefix', (_label, command) => {
    expect(splitPrefix(rewrittenCommand(command)).rest).toBe(command);
  });

  it.each([
    ['a search for the name', 'grep -rn coral-cli src'],
    ['a longer command name', 'coral-cli-dev kb search q'],
    ['an argument to another command', 'echo coral-cli'],
  ])('leaves %s alone', (_label, command) => {
    const result = runBashHook(command);

    expect(result.status).toBe(0);
    expect(parseJsonOutput<unknown>(result.stdout)).toBeNull();
  });

  it('gives a chained, redirected wait the whole Bash timeout without forcing foreground', () => {
    const result = runBashHook('cd "/tmp/x" && coral-cli wait jobs jb-1 --embed > /tmp/out.txt 2>&1');

    const updatedInput = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBe(600_000);
    expect(updatedInput.run_in_background).toBeUndefined();
  });

  it('leaves the timeout of a non-wait coral-cli command alone', () => {
    const updatedInput = expectBashRewriteOutput(runBashHook('coral-cli codex architect -i "wait for it"'))
      .hookSpecificOutput.updatedInput as Record<string, unknown>;

    expect(updatedInput.timeout).toBeUndefined();
  });
});

describe('bash-rewrite.mjs: background-task wrapping', () => {
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
    expect(rewritten).toContain('coral-work');
    expect(rewritten).toContain(`${BRIDGE_DIR}'`);
    expect(rewritten.endsWith('\ncoral-cli kb search q')).toBe(true);
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
    expect(updatedInput.command).toContain(`${BRIDGE_DIR}'`);
    expect(updatedInput.command).not.toContain('coral-work');
    expect(updatedInput.run_in_background).toBe(true);
  });
});
