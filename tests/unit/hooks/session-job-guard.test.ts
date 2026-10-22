import type * as ChildProcessMod from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  executionHarness,
  executionInput,
  openedJob,
  requestedExecution,
  EXECUTION_JOB_ID as jobId,
  EXECUTION_NOW,
} from '#tests/helpers/job-executions.js';

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
const databases: ReturnType<typeof executionHarness>['db'][] = [];

function job(jobId: string, execution = 1, workDir: string | null = root, jobKind = 'provider') {
  return { jobId, execution, status: { execution, jobKind, workDir } };
}

function attentionFixture() {
  const attention = new JobAttention();
  const projectRoot = canonicalizeWorkDir(root, root);
  const h = executionHarness();
  databases.push(h.db);
  const eventBus = new TypedEventBus();
  eventBus.on('job:requested', ({ jobId, execution }) => attention.requested(jobId, execution));
  const store = new JobStore('tests', createRealRuntime('prod', { baseDir: join(root, '.coral') }), h.ctx.bodyCodec, {
    db: h.db,
    providers: h.ctx.providers,
    reducers: h.ctx.reducers,
    eventBus,
  });
  const opened = openedJob({ projectRoot });
  if (opened.body.jobKind !== 'provider') throw new Error('Expected a provider job');
  opened.body.conversation.cwd = projectRoot;
  store.commit((c) => {
    c.append(opened);
    return undefined;
  });
  const request = (execution: number, phase: 'running' | 'queued' = 'running') => {
    store.commit((c) => {
      c.append(requestedExecution(execution, { coralEnv: { CORAL_OWNER: 'session-1' } }));
      return undefined;
    });
    expect(attention.isUnwaited(jobId, execution)).toBe(true);
    store.commit((c) => {
      if (phase === 'queued') {
        c.append(executionInput('job.execution.queued', { execution, queuePosition: 1, runningJobIds: [] }));
      } else {
        c.append(
          executionInput('job.execution.started', {
            execution,
            transport: 'app-server',
            startedAt: EXECUTION_NOW,
            providerMeta: { provider: 'codex', leaseState: 'waiting' },
          }),
        );
      }
      return undefined;
    });
  };
  request(1);
  const ports = createCoordinatorRpcPorts({
    services: { jobAttention: attention },
    getProgressStore: () => store,
    jobAddressing: {
      async *waitStream() {
        yield { type: 'notice', message: 'wait attached' };
      },
    },
  } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);
  state.exec.mockImplementation(() => JSON.stringify(ports.jobs.list({ owner: 'session-1', unwaited: true })));
  return {
    attention,
    ports,
    store,
    end: (execution: number) => store.announceCommitted(h.complete(execution)),
    request,
  };
}

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
  state.exec.mockReturnValue(JSON.stringify(['job-1', 'job-2'].map((jobId) => job(jobId))));
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
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
          '2 Coral job(s) launched in this session are still running with no wait attached. Run coral-cli jobs wait job-1 job-2 to wait for them.',
      });
      expect(state.exec).toHaveBeenCalledWith(
        expect.stringMatching(/clients\/bridge\/coral-cli$/),
        ['jobs', 'list', '--mine', '--unwaited', '--json'],
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
        job('job-1', 1, "/other's project"),
        job('job-2', 1, '/third-project'),
        job('job-3', 1, "/other's project"),
      ]),
    );
    expect((await stop())?.reason).toBe(
      "3 Coral job(s) launched in this session are still running with no wait attached. Run each command below separately to wait for them:\ncd '/other'\\''s project' && coral-cli jobs wait job-1 job-3\ncd '/third-project' && coral-cli jobs wait job-2",
    );
  });

  it('session job guard: lists the plain command first for mixed scopes, including descendants and KB jobs', async () => {
    vi.stubEnv('CLAUDE_PROJECT_DIR', join(root, 'scratch'));
    state.exec.mockReturnValue(
      JSON.stringify([
        job('job-other', 1, '/other-project'),
        job('job-here'),
        job('job-child', 1, join(root, 'child')),
        job('job-kb', 1, null, 'kb'),
      ]),
    );
    expect((await stop())?.reason).toBe(
      "4 Coral job(s) launched in this session are still running with no wait attached. Run each command below separately to wait for them:\ncoral-cli jobs wait job-here job-child job-kb\ncd '/other-project' && coral-cli jobs wait job-other",
    );
  });

  it('session job guard: does not treat a directory with the same prefix as in scope', async () => {
    state.exec.mockReturnValue(JSON.stringify([job('job-other', 1, `${root}-other`)]));
    expect((await stop())?.reason).toBe(
      `1 Coral job(s) launched in this session are still running with no wait attached. Run cd '${root}-other' && coral-cli jobs wait job-other to wait for them.`,
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

  it('session job guard: allows repeated stops for subsets of the blocked set until a wait runs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    expect((await stop())?.decision).toBe('block');
    expect(await stop()).toBeNull();
    state.exec.mockReturnValue(JSON.stringify([job('job-2'), job('job-1')]));
    expect(await stop()).toBeNull();
    state.exec.mockReturnValue(JSON.stringify([job('job-1')]));
    expect(await stop()).toBeNull();
    state.exec.mockReturnValue('[]');
    expect(await stop()).toBeNull();
    state.exec.mockReturnValue(JSON.stringify([job('job-2')]));
    expect(await stop()).toBeNull();
    state.input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: 'session-1',
      cwd: root,
      tool_input: { command: 'coral-cli jobs wait job-1 job-2' },
    };
    // @ts-expect-error — hooks are self-contained ESM without declarations.
    await import('../../../clients/hooks/bash-rewrite.mjs');
    expect((await stop())?.decision).toBe('block');
    expect(await stop()).toBeNull();
  });

  it.each([
    ['a new execution', () => [job('job-1', 2), job('job-2')]],
    ['a new job', () => [job('job-1'), job('job-2'), job('job-3')]],
    ['a replacement job', () => [job('job-3')]],
  ] as const)('session job guard: blocks once for %s after an ignored block', async (_name, current) => {
    expect((await stop())?.decision).toBe('block');
    expect(await stop()).toBeNull();
    state.exec.mockReturnValue(JSON.stringify(current()));
    expect((await stop())?.decision).toBe('block');
    expect(await stop()).toBeNull();
  });

  it('session job guard: holds each successive execution in the same caller session until it ends', async () => {
    const f = attentionFixture();
    for (const execution of [1, 2, 3]) {
      if (execution > 1) f.request(execution);
      expect((await stop())?.decision).toBe('block');
      expect(await stop()).toBeNull();
      f.end(execution);
      expect(await stop()).toBeNull();
    }
  });

  it('session job guard: blocks once for a queued continuation after its predecessor was released', async () => {
    const f = attentionFixture();
    expect((await stop())?.decision).toBe('block');
    expect(await stop()).toBeNull();
    expect(f.ports.jobs.release([jobId]).released).toEqual([jobId]);
    expect(await stop()).toBeNull();
    f.end(1);
    expect(await stop()).toBeNull();
    f.request(2, 'queued');
    expect((await stop())?.decision).toBe('block');
    expect(await stop()).toBeNull();
  });

  it.each(['before', 'after'] as const)(
    'session job guard: a predecessor wait first polled %s continuation cannot hide or detach its successor wait',
    async (firstPoll) => {
      const f = attentionFixture();
      const predecessor = f.store.loadJobDetailResponse(jobId);
      if (predecessor === null) throw new Error('Expected a provider execution');
      const oldWait = f.ports.jobs.waitStream({
        jobIds: [jobId],
        admissions: [{ jobId, disposition: 'admitted', detail: predecessor }],
      });
      if (firstPoll === 'before') {
        await oldWait.next();
        expect(await stop()).toBeNull();
      }
      f.end(1);
      f.request(2, 'queued');
      if (firstPoll === 'after') await oldWait.next();
      expect(f.attention.isUnwaited(jobId, 2)).toBe(true);
      expect((await stop())?.decision).toBe('block');
      expect(await stop()).toBeNull();
      const successor = f.store.loadJobDetailResponse(jobId);
      if (successor === null) throw new Error('Expected a queued continuation');
      const newWait = f.ports.jobs.waitStream({
        jobIds: [jobId],
        admissions: [{ jobId, disposition: 'admitted', detail: successor }],
      });
      await newWait.next();
      await oldWait.return(undefined);
      await oldWait.return(undefined);
      expect(f.attention.isUnwaited(jobId, 2)).toBe(false);
      expect(await stop()).toBeNull();
      await newWait.return(undefined);
      expect(f.attention.isUnwaited(jobId, 2)).toBe(true);
      expect(await stop()).toBeNull();
      f.end(2);
      f.request(3);
      expect((await stop())?.decision).toBe('block');
    },
  );

  it.each([undefined, null, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])(
    'session job guard: fails open for an invalid execution ordinal %s',
    async (execution) => {
      state.exec.mockReturnValue(JSON.stringify([{ ...job('job-1'), execution }]));
      expect(await stop()).toBeNull();
    },
  );

  it('session job guard: fails open if the list becomes unavailable after an ignored block', async () => {
    expect((await stop())?.decision).toBe('block');
    state.exec.mockImplementationOnce(() => {
      throw new Error('coordinator unavailable');
    });
    expect(await stop()).toBeNull();
  });
});
