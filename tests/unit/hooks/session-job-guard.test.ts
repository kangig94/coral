import type * as ChildProcessMod from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ input: {}, exec: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessMod>()),
  execFileSync: state.exec,
}));
vi.mock('../../../clients/hooks/lib/hook-utils.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStdin: async () => JSON.stringify(state.input),
}));

const exited = new Error('hook exited');
let root: string;
let output: string;

async function stop(input: object = { hook_event_name: 'Stop', session_id: 'session-1', cwd: root }) {
  state.input = input;
  output = '';
  vi.resetModules();
  try {
    // @ts-expect-error — hooks are self-contained ESM without declarations.
    await import('../../../clients/hooks/session-job-guard.mjs');
  } catch (error) {
    if (error !== exited) throw error;
  }
  return output.length === 0 ? null : (JSON.parse(output) as { decision: string; reason: string });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coral-job-guard-'));
  mkdirSync(join(root, 'scratch'));
  vi.stubEnv('CORAL_WORK_ROOT_OVERRIDE', join(root, 'scratch'));
  vi.stubEnv('CORAL_CHILD', '');
  vi.stubEnv('CORAL_FLAVOR', 'prod');
  vi.stubEnv('COPILOT_PLUGIN_ROOT', '');
  vi.stubEnv('AI_AGENT', '');
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exited;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  state.exec.mockReturnValue(
    JSON.stringify(['job-1', 'job-2'].map((jobId) => ({ jobId, status: { jobKind: 'provider', workDir: root } }))),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  state.exec.mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe('session job guard', () => {
  it.each(['claude', 'codex', 'copilot'])(
    'session job guard: blocks with the exact wait command for %s',
    async (host) => {
      vi.stubEnv('AI_AGENT', host === 'claude' ? 'claude' : '');
      vi.stubEnv('COPILOT_PLUGIN_ROOT', host === 'copilot' ? root : '');
      expect(await stop()).toEqual({
        decision: 'block',
        reason:
          '2 Coral job(s) launched in this session are still running with no wait attached. Run coral-cli wait jobs job-1 job-2 to wait for them.',
      });
      expect(state.exec).toHaveBeenCalledWith(
        expect.stringMatching(/clients\/bridge\/coral-cli$/),
        ['jobs', '--mine', '--unwaited', '--json'],
        expect.objectContaining({
          timeout: 2_000,
          env: expect.objectContaining({ CORAL_OWNER: 'session-1', PATH: expect.stringContaining('/clients/bridge:') }),
        }),
      );
    },
  );

  it('session job guard: groups other directories and safely quotes them', async () => {
    state.exec.mockReturnValue(
      JSON.stringify([
        { jobId: 'job-1', status: { jobKind: 'provider', workDir: "/other's project" } },
        { jobId: 'job-2', status: { jobKind: 'provider', workDir: '/third-project' } },
        { jobId: 'job-3', status: { jobKind: 'provider', workDir: "/other's project" } },
      ]),
    );
    expect((await stop())?.reason).toBe(
      "3 Coral job(s) launched in this session are still running with no wait attached. Run each command below separately to wait for them:\ncd '/other'\\''s project' && coral-cli wait jobs job-1 job-3\ncd '/third-project' && coral-cli wait jobs job-2",
    );
  });

  it('session job guard: lists the plain command first for mixed scopes, including descendants and KB jobs', async () => {
    vi.stubEnv('CLAUDE_PROJECT_DIR', join(root, 'scratch'));
    state.exec.mockReturnValue(
      JSON.stringify([
        { jobId: 'job-other', status: { jobKind: 'provider', workDir: '/other-project' } },
        { jobId: 'job-here', status: { jobKind: 'provider', workDir: root } },
        { jobId: 'job-child', status: { jobKind: 'provider', workDir: join(root, 'child') } },
        { jobId: 'job-kb', status: { jobKind: 'kb', workDir: null } },
      ]),
    );
    expect((await stop())?.reason).toBe(
      "4 Coral job(s) launched in this session are still running with no wait attached. Run each command below separately to wait for them:\ncoral-cli wait jobs job-here job-child job-kb\ncd '/other-project' && coral-cli wait jobs job-other",
    );
  });

  it('session job guard: does not treat a directory with the same prefix as in scope', async () => {
    state.exec.mockReturnValue(
      JSON.stringify([{ jobId: 'job-other', status: { jobKind: 'provider', workDir: `${root}-other` } }]),
    );
    expect((await stop())?.reason).toBe(
      `1 Coral job(s) launched in this session are still running with no wait attached. Run cd '${root}-other' && coral-cli wait jobs job-other to wait for them.`,
    );
  });

  it('session job guard: allows empty results, failures, timeout and missing session', async () => {
    state.exec.mockReturnValueOnce('[]');
    expect(await stop()).toBeNull();
    for (const error of [new Error('old coordinator'), Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]) {
      state.exec.mockImplementationOnce(() => {
        throw error;
      });
      expect(await stop()).toBeNull();
    }
    state.exec.mockClear();
    expect(await stop({ hook_event_name: 'Stop', cwd: root })).toBeNull();
    expect(state.exec).not.toHaveBeenCalled();
  });

  it('session job guard: allows the second stop until a wait runs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    expect((await stop())?.decision).toBe('block');
    expect(await stop()).toBeNull();
    state.input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'session-1',
      cwd: root,
      tool_input: { command: 'coral-cli wait jobs job-1 job-2' },
    };
    // @ts-expect-error — hooks are self-contained ESM without declarations.
    await import('../../../clients/hooks/bash-rewrite.mjs');
    expect((await stop())?.decision).toBe('block');
  });
});
