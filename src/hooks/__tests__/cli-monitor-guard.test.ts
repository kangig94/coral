import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_MONITOR_GUARD_HOOK, cleanupFixtures, runHook } from './_helpers.js';

afterEach(cleanupFixtures);

describe('cli-monitor-guard.mjs', () => {
  const cliBundle = join(process.cwd(), 'bridge', 'coral-cli.cjs');

  function parseDenyOutput(stdout: string): { decision: string; reason: string } | null {
    const trimmed = stdout.trim();
    if (trimmed === '') return null;
    try {
      const parsed = JSON.parse(trimmed) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      const dec = parsed.hookSpecificOutput?.permissionDecision;
      const reason = parsed.hookSpecificOutput?.permissionDecisionReason;
      if (typeof dec !== 'string' || typeof reason !== 'string') return null;
      return { decision: dec, reason };
    } catch {
      return null;
    }
  }

  it('exits silently for non-PreToolUse events', () => {
    const result = runHook(CLI_MONITOR_GUARD_HOOK, {
      hook_event_name: 'UserPromptSubmit',
      tool_name: 'Monitor',
      tool_input: {},
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('ignores Bash tool calls (matcher-scoped to Monitor)', () => {
    const result = runHook(CLI_MONITOR_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'coral-cli wait --timeout=30' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('denies Monitor spawning bare coral-cli wait', () => {
    const result = runHook(CLI_MONITOR_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { command: 'coral-cli wait --timeout=30' },
    });

    const out = parseDenyOutput(result.stdout);
    expect(out?.decision).toBe('deny');
    expect(out?.reason).toMatch(/Bash/);
  });

  it('denies Monitor spawning a node <bridge> wait invocation', () => {
    const result = runHook(CLI_MONITOR_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { command: `node "${cliBundle}" wait --timeout=30` },
    });

    expect(parseDenyOutput(result.stdout)?.decision).toBe('deny');
  });

  it('denies compound commands that include coral-cli wait in any segment', () => {
    const result = runHook(CLI_MONITOR_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { command: 'echo start && coral-cli wait --timeout=10' },
    });

    expect(parseDenyOutput(result.stdout)?.decision).toBe('deny');
  });

  it('passes through non-coral monitor commands (log tail)', () => {
    const result = runHook(CLI_MONITOR_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { command: 'tail -f /var/log/app.log | grep ERROR' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('passes through coral-cli non-wait subcommands', () => {
    const result = runHook(CLI_MONITOR_GUARD_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { command: 'coral-cli kb search foo' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
