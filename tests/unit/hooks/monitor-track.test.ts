import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MONITOR_TRACK_HOOK,
  cleanupFixtures,
  createFixture,
  expectBashRewriteOutput,
  liveWorkBackgroundDir,
  runHook,
  type HookFixture,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

const SESSION = 'sess-monitor-01';

function bgDir(fixture: HookFixture): string {
  return liveWorkBackgroundDir(fixture, SESSION);
}

function runMonitor(fixture: HookFixture, toolInput: Record<string, unknown>) {
  return runHook(
    MONITOR_TRACK_HOOK,
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      session_id: SESSION,
      cwd: fixture.projectRoot,
      tool_input: toolInput,
    },
    { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
  );
}

describe('monitor-track.mjs', () => {
  it('wraps a bounded Monitor command and records .launched', () => {
    const fixture = createFixture();
    const result = runMonitor(fixture, {
      command: 'tail -f app.log | grep ERROR',
      description: 'errors',
      timeout_ms: 60000,
      persistent: false,
    });

    const rewritten = expectBashRewriteOutput(result).hookSpecificOutput.updatedInput.command;
    expect(rewritten).toContain('coral-work'); // wrapper injected
    expect(rewritten.endsWith('tail -f app.log | grep ERROR')).toBe(true); // original command preserved as the tail
    expect(readdirSync(bgDir(fixture)).some((name) => name.endsWith('.launched'))).toBe(true);
  });

  it('skips persistent monitors (tracking one would stall the ralph loop)', () => {
    const fixture = createFixture();
    const result = runMonitor(fixture, { command: 'tail -f app.log', description: 'log', persistent: true });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(''); // not wrapped
  });

  it('skips the ws-variant monitor (no command to wrap)', () => {
    const fixture = createFixture();
    const result = runMonitor(fixture, {
      ws: { url: 'wss://events.example.com' },
      description: 'ws',
      persistent: false,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('leaves the command unwrapped when session_id is absent', () => {
    const fixture = createFixture();
    const result = runHook(
      MONITOR_TRACK_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Monitor',
        cwd: fixture.projectRoot,
        tool_input: { command: 'tail -f app.log', description: 'x', persistent: false },
      },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
