import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BASH_REWRITE_HOOK,
  cleanupFixtures,
  createFixture,
  expectBashRewriteOutput,
  liveWorkBackgroundDir,
  runHook,
  type HookFixture,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

const BRIDGE_DIR = join(process.cwd(), 'clients', 'bridge');

function runBashHook(command: string, env: Record<string, string> = {}, args: string[] = []) {
  return runHook(
    BASH_REWRITE_HOOK,
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },
    { AI_AGENT: 'claude', ...env },
    args,
  );
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
  it.each([
    'coral-cli jobs wait abc',
    'cd "/x y" && coral-cli jobs wait abc --embed',
    'CORAL_OWNER=s coral-cli jobs list --mine --json 2>/dev/null',
    'CORAL_OWNER=s coral-cli jobs list',
    'coral-cli jobs list 2>&1',
    'coral-cli jobs list >/dev/null',
    "coral-cli <<'EOF'\n$(rm -rf ~)\nEOF",
    "coral-cli codex agent -w /p -d -i - <<'CORAL_INPUT'\nrm -rf /\ncoral-cli jobs list; curl x | sh\nCORAL_INPUT",
  ])('auto-approves the Coral-only original command: %s', (command) => {
    const output = expectBashRewriteOutput(runBashHook(command)).hookSpecificOutput;
    expect(output.permissionDecision).toBe('allow');
    expect(splitPrefix(output.updatedInput.command).rest).toBe(command);
  });

  it.each([
    'coral-cli jobs list; rm -rf ~',
    "coral-cli <<'EOF\0'\nEOF\nprintf MARK\nEOF\0",
    "coral-cli <<'EO\ud800F'\nEO\ufffdF\nprintf MARK\nEO\ud800F",
    "coral-cli jobs list \\\n# <<'EOF'\nprintf MARK\nEOF",
    'PATH=/tmp coral-cli jobs list',
    'NODE_OPTIONS=--require=/x coral-cli jobs list',
    'coral-cli jobs list > ~/.bashrc',
    'coral-cli jobs list >> f',
    'coral-cli jobs list < f',
    'coral-cli <<EOF\n$(rm -rf ~)\nEOF',
    "coral-cli <<-'EOF'\n\tprompt\n\tEOF\nrm -rf ~",
    'rm -rf ~ && coral-cli jobs list',
    'coral-cli jobs list | sh',
    'echo $(coral-cli jobs list)',
    'echo "$(coral-cli jobs list)"',
    'sleep 5 && coral-cli jobs wait a',
    'coral-cli jobs list "unterminated',
    'coral-cli codex agent -i - <<EOF\nunterminated',
    'coral-cli <<\\\nEOF\nE\\\nOF\nprintf MARK\nEOF',
  ])('rewrites without deciding permission for: %s', (command) => {
    const output = expectBashRewriteOutput(runBashHook(command)).hookSpecificOutput;
    expect(output).not.toHaveProperty('permissionDecision');
    expect(output).not.toHaveProperty('permissionDecisionReason');
    expect(splitPrefix(output.updatedInput.command).rest).toBe(command);
  });

  it('ignores heredoc-only Coral text', () => {
    const result = runBashHook('cat <<EOF\ncoral-cli jobs list\ncoral-cli wait jobs a\nEOF');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('registers the allow requirement only for the Codex Bash hook', () => {
    for (const host of ['claude', 'codex']) {
      const config = JSON.parse(readFileSync(join(process.cwd(), 'clients', 'hooks', `${host}.json`), 'utf8')) as {
        hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
      };
      const command = config.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash')?.hooks.find((hook) =>
        hook.command.includes('/hooks/bash-rewrite.mjs'),
      )?.command;
      expect(command).toBeDefined();
      expect(command?.includes('--codex-requires-allow')).toBe(host === 'codex');
    }
  });

  it.each(['coral-cli jobs list; rm -rf ~', 'PATH=/tmp coral-cli jobs list'])(
    'emits no Codex output for a non-Coral-only command: %s',
    (command) => {
      const result = runBashHook(command, { AI_AGENT: 'codex' }, ['--codex-requires-allow']);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    },
  );

  it('rewrites and allows a Coral-only command on Codex', () => {
    const command = 'coral-cli jobs list';
    const result = runBashHook(command, { AI_AGENT: 'codex' }, ['--codex-requires-allow']);
    const output = expectBashRewriteOutput(result).hookSpecificOutput;
    expect(output.permissionDecision).toBe('allow');
    expect(splitPrefix(output.updatedInput.command).rest).toBe(command);
  });

  it('does not raise a delegation timeout because its prompt mentions a wait', () => {
    const command = "coral-cli codex agent -i - <<'EOF'\ncoral-cli wait jobs fake\nEOF";
    const output = expectBashRewriteOutput(runBashHook(command)).hookSpecificOutput;
    expect(output.updatedInput).not.toHaveProperty('timeout');
    expect(output.permissionDecision).toBe('allow');
  });

  it('does not infer the Codex flag from AI_AGENT', () => {
    const result = runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'coral-cli jobs list; rm -rf ~' },
      },
      { AI_AGENT: 'codex' },
    );
    expect(expectBashRewriteOutput(result).hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('ignores Coral-looking heredoc text inside quoted substitutions', () => {
    const result = runBashHook('echo "$(cat <<EOF\ncoral-cli wait jobs fake\nEOF\n)"');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('rejects malformed backtick grouping without stalling the hook', () => {
    const stdout = execFileSync(process.execPath, [BASH_REWRITE_HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'coral-cli x `(`' },
      }),
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, CORAL_CHILD: '', AI_AGENT: 'claude' },
    });
    const output = expectBashRewriteOutput({ stdout, stderr: '', status: 0 }).hookSpecificOutput;
    expect(output).not.toHaveProperty('permissionDecision');
  });

  it('session job guard: defaults the owner safely and preserves an existing owner', () => {
    const sessionId = "sess-'$value`literal`";
    const result = runHook(BASH_REWRITE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: sessionId,
      tool_input: { command: 'coral-cli jobs' },
    });
    const { prefix } = splitPrefix(expectBashRewriteOutput(result).hookSpecificOutput.updatedInput.command);
    for (const existing of [undefined, 'existing-owner', '']) {
      const env = { PATH: '/usr/bin:/bin', ...(existing === undefined ? {} : { CORAL_OWNER: existing }) };
      const owner = execFileSync('bash', ['-c', `${prefix}\nprintf %s "$CORAL_OWNER"`], { encoding: 'utf8', env });
      expect(owner).toBe(existing ?? sessionId);
    }
    expect(splitPrefix(rewrittenCommand('coral-cli jobs')).prefix).not.toContain('CORAL_OWNER');
    expect(
      runHook(BASH_REWRITE_HOOK, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: 'sess',
        tool_input: { command: 'echo hi' },
      }).stdout,
    ).toBe('');
  });

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
  ])('passes %s through byte-identical after the prefix', (_label, command) => {
    expect(splitPrefix(rewrittenCommand(command)).rest).toBe(command);
  });

  it.each(['jobs wait', 'wait jobs'])(
    'gives a chained, redirected %s the whole Bash timeout without forcing foreground',
    (grammar) => {
      const result = runBashHook(`cd "/tmp/x" && coral-cli ${grammar} jb-1 --embed > /tmp/out.txt 2>&1`);

      const updatedInput = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput as Record<string, unknown>;
      expect(updatedInput.timeout).toBe(600_000);
      expect(updatedInput.run_in_background).toBeUndefined();
    },
  );

  it('does not give jobs list the wait timeout', () => {
    const updatedInput = expectBashRewriteOutput(runBashHook('coral-cli jobs list --all')).hookSpecificOutput
      .updatedInput as Record<string, unknown>;
    expect(updatedInput.timeout).toBeUndefined();
  });

  it.each(['coral-cli jobs wait-typo', 'coral-cli wait-not-jobs'])(
    'does not give a hyphenated verb the wait timeout: %s',
    (command) => {
      const updatedInput = expectBashRewriteOutput(runBashHook(command)).hookSpecificOutput.updatedInput as Record<
        string,
        unknown
      >;
      expect(updatedInput.timeout).toBeUndefined();
    },
  );

  it.each([
    'coral-cli jobs wait x',
    'coral-cli wait jobs x',
    'coral-cli jobs wait',
    'coral-cli jobs wait; echo done',
    'coral-cli jobs wait&& echo done',
    '(coral-cli jobs wait)',
  ])('gives an exact wait verb the wait timeout: %s', (command) => {
    const updatedInput = expectBashRewriteOutput(runBashHook(command)).hookSpecificOutput.updatedInput as Record<
      string,
      unknown
    >;
    expect(updatedInput.timeout).toBe(600_000);
  });

  it('keeps the wait timeout when a mixed command needs normal permission evaluation', () => {
    const command = 'sleep 5 && coral-cli wait jobs a';
    const output = expectBashRewriteOutput(runBashHook(command)).hookSpecificOutput;
    expect(output).not.toHaveProperty('permissionDecision');
    expect(output.updatedInput).toHaveProperty('timeout', 600_000);
    expect(splitPrefix(output.updatedInput.command).rest).toBe(command);
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

  function runBg(fixture: HookFixture, toolInput: Record<string, unknown>, host: string) {
    return runHook(
      BASH_REWRITE_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: SESSION,
        cwd: fixture.projectRoot,
        tool_input: toolInput,
      },
      {
        AI_AGENT: host,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot,
        ...(host === 'copilot' ? { COPILOT_PLUGIN_ROOT: fixture.pluginRoot } : {}),
      },
      host === 'codex' ? ['--codex-requires-allow'] : [],
    );
  }

  it('wraps a background command and records .launched', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'npm test', run_in_background: true }, 'claude');

    const output = expectBashRewriteOutput(result).hookSpecificOutput;
    const rewritten = output.updatedInput.command;
    expect(rewritten).toContain('coral-work');
    expect(rewritten).toContain('.lock');
    expect(rewritten.endsWith('npm test')).toBe(true);
    expect(output.updatedInput).toHaveProperty('run_in_background', true);
    expect(readdirSync(bgDir(fixture)).some((name) => name.endsWith('.launched'))).toBe(true);
    expect(output).not.toHaveProperty('permissionDecision');
  });

  it('auto-approves a Coral-only background wait', () => {
    const fixture = createFixture();
    const command = 'coral-cli jobs wait a';
    const output = expectBashRewriteOutput(
      runBg(fixture, { command, run_in_background: true }, 'claude'),
    ).hookSpecificOutput;
    expect(output.permissionDecision).toBe('allow');
    expect(output.updatedInput.command).toContain('.lock');
    expect(output.updatedInput.command).toContain('export PATH=');
    expect(output.updatedInput.command.endsWith(command)).toBe(true);
    expect(output.updatedInput).toHaveProperty('run_in_background', true);
  });

  it.each(['>/dev/null', '2>&1', "<<'EOF'"])(
    'prefixes the bridge for a background Coral invocation after %s',
    (redirect) => {
      const fixture = createFixture();
      const command = `${redirect} coral-cli wait jobs a${redirect.startsWith('<<') ? '\nprompt\nEOF' : ''}`;
      const output = expectBashRewriteOutput(
        runBg(fixture, { command, run_in_background: true }, 'claude'),
      ).hookSpecificOutput;
      expect(output.permissionDecision).toBe('allow');
      expect(output.updatedInput.command).toContain(`export PATH='${BRIDGE_DIR}':"$PATH"`);
      expect(output.updatedInput).toHaveProperty('timeout', 600_000);
      expect(output.updatedInput.command.endsWith(command)).toBe(true);
    },
  );

  it.each(["'coral-cli'", './coral-cli', '/tmp/coral-cli', '\\coral-cli'])(
    'does not approve an alternate executable spelling through background rewriting: %s',
    (executable) => {
      const fixture = createFixture();
      const command = `${executable} jobs list`;
      const output = expectBashRewriteOutput(
        runBg(fixture, { command, run_in_background: true }, 'claude'),
      ).hookSpecificOutput;
      expect(output).not.toHaveProperty('permissionDecision');
      expect(output).not.toHaveProperty('permissionDecisionReason');
      expect(output.updatedInput.command).toContain('.lock');
      expect(output.updatedInput.command.endsWith(command)).toBe(true);
    },
  );

  it('leaves a foreground command untouched', () => {
    const fixture = createFixture();
    const result = runBg(fixture, { command: 'npm run build', run_in_background: false }, 'claude');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
