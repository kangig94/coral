import { readdirSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupFixtures, createFixture, liveWorkBackgroundDir } from '#tests/unit/hooks/_helpers.js';

const input = vi.hoisted(() => ({ persistent: false }));
const output = vi.hoisted(() => vi.fn());
vi.mock('../../../clients/hooks/lib/hook-utils.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exitIfChildProcess: () => {},
  exitIfWrongFlavor: () => {},
  readStdin: async () =>
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      session_id: 'sess-monitor-01',
      cwd: process.env.CLAUDE_PROJECT_DIR,
      tool_input: { command: 'tail -f app.log | grep ERROR', persistent: input.persistent },
    }),
  writeHookOutput: output,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  output.mockClear();
  cleanupFixtures();
});

it('keeps the monitor command and records its background marker', async () => {
  const fixture = createFixture();
  vi.stubEnv('CLAUDE_PROJECT_DIR', fixture.projectRoot);
  vi.stubEnv('CORAL_WORK_ROOT_OVERRIDE', fixture.workRoot);
  input.persistent = false;
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('unexpected exit');
  });

  // @ts-expect-error — hooks are executable .mjs modules without declarations.
  await import('../../../clients/hooks/monitor-track.mjs');

  expect(exit).not.toHaveBeenCalled();
  const command = output.mock.calls[0]?.[0].hookSpecificOutput.updatedInput.command as string;
  expect(command.endsWith('\ntail -f app.log | grep ERROR')).toBe(true);
  const markers = readdirSync(liveWorkBackgroundDir(fixture, 'sess-monitor-01'));
  expect(markers.filter((name) => name.endsWith('.launched'))).toHaveLength(1);
});

it('leaves persistent monitors untracked', async () => {
  input.persistent = true;
  const exit = new Error('hook finished');
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exit;
  });

  // @ts-expect-error — hooks are executable .mjs modules without declarations.
  await expect(import('../../../clients/hooks/monitor-track.mjs')).rejects.toBe(exit);

  expect(output).not.toHaveBeenCalled();
});
