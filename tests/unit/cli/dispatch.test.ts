import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as IpcClientMod from '#src/transport/ipc/client.js';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockState = vi.hoisted(() => ({
  liveRequest: vi.fn(),
  discovery: vi.fn(() => ({ kind: 'missing' }) as unknown),
  createLiveClient: vi.fn(),
  request: vi.fn(),
  subscribe: vi.fn(),
  health: vi.fn(async () => ({ components: [] as Array<Record<string, unknown>> })),
  readStore: {
    jobs: { detail: vi.fn() },
    kb: { listMemos: vi.fn(() => []) },
    discuss: {
      watch: vi.fn(),
    },
  },
}));

const tempDirs: string[] = [];
let projectRoot: string;

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-cli-provider-scope-'));
  tempDirs.push(root);
  return root;
}

vi.mock('#src/transport/ipc/ensure.js', () => {
  const client = {
    request: mockState.request,
    subscribe: mockState.subscribe,
    health: mockState.health,
  };
  const ensure = vi.fn(async () => client);
  return {
    ensure,
    // What the lifecycle fallback does with a refusal is pinned in tests/unit/transport/ipc/ensure.test.ts;
    // here it stands in only as the one reach a dispatched request makes before issuing.
    issueWithSuccessorAfterLifecycleRefusal: vi.fn(
      async (_method: string, _pluginRoot: string | undefined, issue: (reached: unknown) => Promise<unknown>) =>
        issue(await ensure()),
    ),
  };
});

vi.mock('#src/infra/backend-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof BackendDiscoveryMod>()),
  readDiscoveryRecordDisposition: mockState.discovery,
}));
vi.mock('#src/transport/ipc/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof IpcClientMod>()),
  createIpcClient: mockState.createLiveClient,
}));

vi.mock('#src/cli/read-store.js', () => ({
  getSharedReadCoralStore: vi.fn(() => mockState.readStore),
}));

import { ensure, issueWithSuccessorAfterLifecycleRefusal } from '#src/transport/ipc/ensure.js';
import { makeClient } from '#src/cli/dispatch.js';
import { formatJobSendResult } from '#src/cli/format/jobs.js';
import { IpcLifecycleRefusal, IpcRpcError } from '#src/transport/ipc/client.js';
import { jobSendSchema } from '#src/transport/rpc/jobs.js';
import { markProviderCommand } from '#src/cli/classify.js';
import { FORWARDED_NETWORK_ENV_KEYS } from '#src/infra/network-env.js';
import { BackendUnreachableError } from '#src/infra/http-errors.js';
import { installWaitInvocation, WaitInvocation } from '#src/cli/wait-invocation.js';

function findCommand(root: Command, ...path: string[]): Command {
  let current = root;

  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) {
      throw new Error(`Expected command path ${path.join(' ')} to exist`);
    }
    current = next;
  }

  return current;
}

function buildProgram(): Command {
  const program = new Command();
  const jobs = program.command('jobs');
  jobs.command('list');
  jobs.command('wait');
  program.command('wait').command('jobs');
  jobs.command('detail');
  jobs.command('release');
  jobs.command('send');
  const kb = program.command('kb');
  kb.command('reindex');
  kb.command('memo').command('list');
  const discuss = program.command('discuss');
  discuss.command('watch');
  markProviderCommand(program.command('claude'));
  program.command('workflow');
  return program;
}

function stubNonChildInvocationEnv(): void {
  vi.stubEnv('CORAL_CHILD', '');
  vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
  vi.stubEnv('CORAL_JOB_ID', '');
  vi.stubEnv('CORAL_SESSION_ID', '');
}

describe('command client routing', () => {
  it.each([
    ['jobs', 'wait'],
    ['wait', 'jobs'],
  ])('attaches the invocation to the %s %s subscription', async (group, verb) => {
    const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', group, verb, 'a'], { now: () => 0 });
    installWaitInvocation(invocation);
    const subscription = { events: [], close: vi.fn() };
    mockState.subscribe.mockResolvedValue(subscription);
    try {
      const client = makeClient(projectRoot, findCommand(buildProgram(), group, verb));
      expect(await client.subscribeJobsWait({ jobIds: ['a'], projectRoot })).toBe(subscription);
      expect(mockState.subscribe).toHaveBeenCalledWith(
        'jobs.wait',
        expect.anything(),
        expect.objectContaining({
          signal: invocation.signal,
        }),
      );
      invocation.stop();
      await expect(client.subscribeJobsWait({ jobIds: ['a'], projectRoot })).rejects.toThrow('Wait invocation ended');
    } finally {
      installWaitInvocation(undefined);
      invocation.dispose(true);
    }
  });
  beforeEach(() => {
    mockState.request.mockReset();
    mockState.readStore.jobs.detail.mockReturnValue({
      requestedSeq: 2,
      epochKey: 'epoch',
      status: { execution: 1, phase: 'running', finishing: false, provider: 'claude' },
    });
    stubNonChildInvocationEnv();
    mockState.discovery.mockReturnValue({ kind: 'missing' });
    mockState.createLiveClient.mockReturnValue({ request: mockState.liveRequest });
    projectRoot = makeTempDir();
    vi.stubEnv('CLAUDE_CONFIG_DIR', makeTempDir());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempDirs.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('session job guard: prefers environment ownership and forwards it on provider and workflow launches', async () => {
    const program = buildProgram();
    vi.stubEnv('CLAUDE_CONFIG_DIR', makeTempDir());
    for (const envOwner of ['session-env', undefined]) {
      vi.stubEnv('CORAL_OWNER', envOwner);
      mockState.request.mockResolvedValue({ state: 'accepted', jobId: 'job-1' });
      await makeClient(projectRoot, findCommand(program, 'claude')).createSession('claude', 'hi', {
        owner: 'legacy-flag',
      });
      expect(mockState.request.mock.lastCall?.[1]).toMatchObject({ owner: envOwner ?? 'legacy-flag' });
      expect((mockState.request.mock.lastCall?.[1] as { coralEnv: Record<string, string> }).coralEnv.CORAL_OWNER).toBe(
        envOwner,
      );
      await makeClient(projectRoot, findCommand(program, 'workflow')).workflow('architect', {
        startPrompt: 'hi',
        owner: 'legacy-flag',
      });
      expect(mockState.request.mock.lastCall?.[1]).toMatchObject({ owner: envOwner ?? 'legacy-flag' });
    }
  });

  it('session job guard: prefers the environment for memo owner filters and retains the legacy fallback', async () => {
    mockState.readStore.kb = { listMemos: vi.fn(() => []) };
    for (const envOwner of ['session-env', undefined]) {
      vi.stubEnv('CORAL_OWNER', envOwner);
      const client = makeClient(projectRoot, findCommand(buildProgram(), 'kb', 'memo', 'list'));
      await client.kbMemoList({ owner: 'legacy-flag' });
      expect(mockState.readStore.kb.listMemos).toHaveBeenLastCalledWith({ owner: envOwner ?? 'legacy-flag' });
    }
  });

  it('session job guard: sends release through the strict RPC request schema', async () => {
    const { jobsReleaseRequestSchema } = await import('#src/transport/rpc/jobs.js');
    mockState.request.mockImplementationOnce(async (method: string, params: unknown) => {
      expect(method).toBe('jobs.release');
      expect(jobsReleaseRequestSchema.parse(params)).toEqual({ jobs: ['job-1'], projectRoot });
      return { released: ['job-1'], unknown: [], terminal: [] };
    });
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'release'));
    expect(await client.releaseJobs(['job-1'])).toEqual({ released: ['job-1'], unknown: [], terminal: [] });
  });

  it('sends the canonical caller root and a fresh UUID for each send invocation', async () => {
    const alias = join(makeTempDir(), 'project-link');
    symlinkSync(projectRoot, alias, 'dir');
    mockState.request.mockResolvedValue({ state: 'delivered' });
    const client = makeClient(alias, findCommand(buildProgram(), 'jobs', 'send'));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await client.sendJob('job-1', 'message')).toEqual({ state: 'delivered' });
    }
    const params = mockState.request.mock.calls.map(([method, value, options]) => {
      expect(method).toBe('jobs.send');
      expect(options).toMatchObject({ timeoutMs: 20_000 });
      return jobSendSchema.parse(value);
    });
    expect(params).toHaveLength(2);
    for (const value of params)
      expect(value).toMatchObject({ projectRoot: realpathSync(projectRoot), jobId: 'job-1', input: 'message' });
    expect(params[0].clientMessageId).not.toBe(params[1].clientMessageId);
  });

  it.each([
    { state: 'delivered' },
    { state: 'refused', code: 'control_unavailable', reason: 'Control is recovering.' },
    { state: 'unknown', reason: 'Provider response timed out.' },
  ])('preserves a validated send outcome %j without replay', async (result) => {
    mockState.request.mockResolvedValueOnce(result);
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send'));
    expect(await client.sendJob('job-1', 'message')).toEqual(result);
    expect(mockState.request).toHaveBeenCalledOnce();
  });

  it.each([
    ['null result', null],
    ['absent result', undefined],
    ['unrecognized state', { state: 'accepted' }],
    ['missing refusal reason', { state: 'refused', code: 'turn_ended' }],
    ['unknown refusal code', { state: 'refused', code: 'other', reason: 'No.' }],
    ['invalid unknown reason', { state: 'unknown', reason: 123 }],
    ['extra delivery fields', { state: 'delivered', unexpected: true }],
  ])('reports %s as unknown/75 without a retry remedy', async (_name, result) => {
    mockState.request.mockResolvedValueOnce(result);
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send'));
    const outcome = await client.sendJob('job-1', 'message');
    expect(outcome).toMatchObject({ state: 'unknown' });
    const output = formatJobSendResult('job-1', outcome);
    expect(output.exitCode).toBe(75);
    expect(output.text).toContain('may have been delivered');
    expect(output.text).toContain('command=coral-cli jobs wait job-1');
    expect(output.text).not.toMatch(/retry|resend|jobs send|backend status/i);
    expect(mockState.request).toHaveBeenCalledOnce();
    expect(issueWithSuccessorAfterLifecycleRefusal).toHaveBeenCalledOnce();
  });

  it.each([
    ['disconnect', new Error('IPC connection closed; retry')],
    ['timeout', new Error('IPC request timed out')],
    [
      'succession pause',
      new IpcRpcError({ code: -32000, message: 'Paused', data: { code: 'succession_admission_paused' } }),
    ],
  ])('reports post-issue %s as unknown/75 after at most one bound retry', async (_name, error) => {
    mockState.request.mockRejectedValue(error);
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send'));
    const outcome = await client.sendJob('job-1', 'message');
    expect(outcome).toMatchObject({ state: 'unknown' });
    const output = formatJobSendResult('job-1', outcome);
    expect(output.exitCode).toBe(75);
    expect(output.text).not.toMatch(/retry|resend|jobs send|backend status/i);
    const calls = error instanceof IpcRpcError ? 1 : 2;
    expect(mockState.request).toHaveBeenCalledTimes(calls);
    expect(ensure).toHaveBeenCalledTimes(calls);
  });

  it('reports an older coordinator as refused/1 with restart guidance and no retry remedy', async () => {
    mockState.request.mockRejectedValueOnce(new IpcRpcError({ code: -32601, message: 'Method not found' }));
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send'));
    const outcome = await client.sendJob('job-1', 'message');
    expect(outcome).toEqual({
      state: 'refused',
      code: 'unsupported_by_running_build',
      reason:
        'The running Coral build predates jobs send. Restart the session so the current Coral plugin loads; the coordinator follows the installed build.',
    });
    const output = formatJobSendResult('job-1', outcome);
    expect(output.exitCode).toBe(1);
    expect(output.text).toContain('unsupported_by_running_build');
    expect(output.text).toContain('The running Coral build predates jobs send.');
    expect(output.text).toContain('Restart the session so the current Coral plugin loads');
    expect(output.text).not.toMatch(/retry|resend|command=|may have been delivered/i);
    expect(mockState.request).toHaveBeenCalledOnce();
    expect(ensure).toHaveBeenCalledOnce();
    expect(issueWithSuccessorAfterLifecycleRefusal).toHaveBeenCalledOnce();
  });

  it('validates send input before contacting the coordinator', async () => {
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send'));
    await expect(client.sendJob('job-1', ' ')).rejects.toThrow();
    expect(ensure).not.toHaveBeenCalled();
    expect(mockState.request).not.toHaveBeenCalled();
  });

  it('keeps a pre-issue ensure failure distinct from an unknown send', async () => {
    const error = new BackendUnreachableError('Coordinator unavailable before issue');
    vi.mocked(ensure).mockRejectedValueOnce(error);
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send'));
    await expect(client.sendJob('job-1', 'message')).rejects.toBe(error);
    expect(mockState.request).not.toHaveBeenCalled();
  });

  it('keeps a final lifecycle refusal distinct from response loss', async () => {
    const error = new IpcLifecycleRefusal('/socket', 'jobs.send');
    mockState.request.mockRejectedValueOnce(error);
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send'));
    await expect(client.sendJob('job-1', 'message')).rejects.toBe(error);
    expect(mockState.request).toHaveBeenCalledOnce();
  });

  it('session job guard: authenticates live owner-scoped queries without starting a coordinator', async () => {
    const { jobsListRequestSchema } = await import('#src/transport/rpc/jobs.js');
    vi.stubEnv('CORAL_OWNER', 'session-env');
    mockState.discovery.mockReturnValue({
      kind: 'record',
      record: { socketPath: '/test/socket', bootToken: 'test-boot-token' },
    });
    mockState.liveRequest.mockImplementationOnce(async (method: string, params: unknown) => {
      expect(method).toBe('jobs.list');
      expect(jobsListRequestSchema.parse(params)).toEqual({ owner: 'session-env', unwaited: true });
      return { jobs: [{ jobId: 'job-live', released: true }] };
    });
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'list'));
    expect(await client.listJobs({ mine: true, unwaited: true, allProjects: true })).toEqual({
      jobs: [{ jobId: 'job-live', released: true }],
    });
    expect(mockState.createLiveClient).toHaveBeenCalledWith('/test/socket', expect.any(Object), {
      kind: 'boot',
      token: 'test-boot-token',
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('session job guard: returns no owned unwaited jobs without starting a coordinator', async () => {
    vi.stubEnv('CORAL_OWNER', 'session-env');
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'list'));
    await expect(client.listJobs({ mine: true, unwaited: true, allProjects: true })).resolves.toEqual({ jobs: [] });
    expect(ensure).not.toHaveBeenCalled();
    expect(mockState.request).not.toHaveBeenCalled();
    vi.stubEnv('CORAL_OWNER', undefined);
    await expect(
      makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'list')).listJobs({ mine: true }),
    ).rejects.toThrow('Set CORAL_OWNER');
  });

  it('sends the canonical target when the invocation project root is a symlink', async () => {
    const physicalProject = join(projectRoot, 'physical-project');
    const selectedProject = join(projectRoot, 'selected-project');
    mkdirSync(physicalProject);
    symlinkSync(physicalProject, selectedProject, 'dir');
    mockState.request.mockResolvedValueOnce({ jobs: [] });

    const client = makeClient(selectedProject, findCommand(buildProgram(), 'claude'));
    await client.listJobs({ phase: 'running' });

    expect(mockState.request).toHaveBeenCalledWith(
      'jobs.list',
      { projectRoot: realpathSync(physicalProject), phase: 'running' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('rejects a null operational response as an unreachable backend', async () => {
    mockState.request.mockResolvedValueOnce(null);
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'detail'));

    const error = await client.detailJob('job-1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BackendUnreachableError);
    expect(error).toMatchObject({
      message: 'Coral coordinator did not answer jobs.detail. Run `coral-cli backend status` and retry.',
    });
  });

  it('forwards the caller shell proxy/CA env to provider launches as networkEnv', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', makeTempDir());
    for (const key of FORWARDED_NETWORK_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    vi.stubEnv('HTTP_PROXY', 'http://proxy:8080');
    vi.stubEnv('NO_PROXY', 'localhost');
    mockState.request.mockResolvedValueOnce({ job: 'session-job' });
    const program = buildProgram();
    const client = makeClient(projectRoot, findCommand(program, 'claude'));

    await client.createSession('claude', 'hi', {});

    expect(mockState.request).toHaveBeenCalledWith(
      'sessions.create',
      expect.objectContaining({
        provider: 'claude',
        prompt: 'hi',
        networkEnv: { HTTP_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost' },
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('forwards the caller CORAL_* config to provider launches and drops daemon-owned keys', async () => {
    vi.stubEnv('CORAL_CODEX_MODEL', 'gpt-5.6-sol');
    vi.stubEnv('CLAUDE_CONFIG_DIR', makeTempDir());
    // A daemon-owned key present in the caller env must never ride along on the
    // wire. (CORAL_JOB_ID etc. are exercised in the env-sanitize unit tests;
    // here we use an inert daemon-owned key so we don't trip child-IPC auth.)
    vi.stubEnv('CORAL_ENV_PASSTHROUGH', 'FOO');
    mockState.request.mockResolvedValueOnce({ job: 'session-job' });
    const program = buildProgram();
    const client = makeClient(projectRoot, findCommand(program, 'claude'));

    await client.createSession('claude', 'hi', {});

    const [, body] = mockState.request.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.coralEnv).toMatchObject({ CORAL_CODEX_MODEL: 'gpt-5.6-sol' });
    expect(body.coralEnv).not.toHaveProperty('CORAL_ENV_PASSTHROUGH');
  });

  it('scopes jobs.list to the caller project root by default', async () => {
    mockState.request.mockResolvedValueOnce({ jobs: [] });
    const program = buildProgram();
    const client = makeClient(projectRoot, findCommand(program, 'claude'));

    await client.listJobs({ phase: 'running' });

    expect(mockState.request).toHaveBeenCalledWith(
      'jobs.list',
      { projectRoot, phase: 'running' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('reads discuss watch from CoralStore without starting the coordinator', async () => {
    const watchState = {
      session: 'discuss-1',
      status: 'ended',
      topic: 'Architecture',
      epoch: 1,
      step: 2,
      events: [],
      cursor: 0,
    };
    mockState.readStore.discuss.watch.mockReturnValueOnce(watchState);
    const program = buildProgram();
    const client = makeClient(projectRoot, findCommand(program, 'discuss', 'watch'));

    await expect(client.discussWatch('discuss-1', 3)).resolves.toBe(watchState);

    expect(mockState.readStore.discuss.watch).toHaveBeenCalledWith('discuss-1', 3);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('rejects incomplete child auth before ensure or lazy KB lifecycle reconciliation', async () => {
    vi.stubEnv('CORAL_CHILD', '1');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', 'parent-job');
    vi.stubEnv('CORAL_SESSION_ID', 'parent-session');
    vi.stubEnv('CORAL_KB_ENABLE', '1');
    const program = buildProgram();
    const client = makeClient(projectRoot, findCommand(program, 'kb', 'reindex'));

    await expect(client.kbSearch({ query: 'child query' })).rejects.toThrow(
      'This nested Coral command has incomplete child credentials and was not sent',
    );

    expect(ensure).not.toHaveBeenCalled();
    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.request).not.toHaveBeenCalled();
  });
});

describe('jobs send immutable attempt envelope', () => {
  beforeEach(() => {
    mockState.request.mockReset();
    mockState.readStore.jobs.detail.mockReset();
    mockState.discovery.mockReturnValue({ kind: 'missing' });
    stubNonChildInvocationEnv();
    projectRoot = makeTempDir();
    vi.stubEnv('CLAUDE_CONFIG_DIR', makeTempDir());
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(['steer', 'continue'] as const)(
    'retains the complete %s envelope after a lost response and successor handoff',
    async (mode) => {
      const detail = {
        requestedSeq: 20,
        epochKey: 'epoch-original',
        status: {
          provider: 'claude',
          execution: 2,
          phase: mode === 'continue' ? 'completed' : 'running',
          finishing: false,
        },
      };
      mockState.readStore.jobs.detail
        .mockReturnValueOnce(detail)
        .mockReturnValue({ ...detail, requestedSeq: 90, status: { ...detail.status, execution: 3, phase: 'running' } });
      vi.stubEnv('CORAL_OWNER', 'caller');
      vi.stubEnv('HTTPS_PROXY', 'http://caller-proxy:1234');
      mockState.request
        .mockImplementationOnce(async () => {
          throw new Error('response lost');
        })
        .mockRejectedValueOnce(new IpcLifecycleRefusal('/incumbent', 'jobs.send'))
        .mockResolvedValueOnce(
          mode === 'continue'
            ? {
                state: 'launched',
                launch: {
                  kind: 'provider-session',
                  launchState: 'queued',
                  jobId: 'job-1',
                  requestedSeq: 30,
                  epochKey: 'epoch-original',
                },
              }
            : { state: 'unknown', reason: 'Original operation has closed; prior delivery remains unknown.' },
        );
      const reached = { request: mockState.request } as unknown as Awaited<ReturnType<typeof ensure>>;
      vi.mocked(issueWithSuccessorAfterLifecycleRefusal)
        .mockImplementationOnce(async (_method, _pluginRoot, issue) => issue(reached))
        .mockImplementationOnce(async (_method, _pluginRoot, issue) => {
          try {
            return await issue(reached);
          } catch (error: unknown) {
            if (!(error instanceof IpcLifecycleRefusal)) throw error;
            return issue(reached);
          }
        });
      const outcome = await makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send')).sendJob(
        'job-1',
        'immutable input',
      );
      expect(outcome.state).toBe(mode === 'continue' ? 'launched' : 'unknown');
      expect(mockState.readStore.jobs.detail).toHaveBeenCalledTimes(1);
      expect(mockState.request).toHaveBeenCalledTimes(3);
      const [first, second, successor] = mockState.request.mock.calls;
      expect(first[1]).toEqual(second[1]);
      expect(first[1]).toBe(second[1]);
      expect(successor[1]).toBe(first[1]);
      expect(first[1]).toMatchObject({
        target: { mode, execution: 2, requestedSeq: 20, sourceEpoch: 'epoch-original' },
        input: 'immutable input',
        clientMessageId: expect.any(String),
        owner: 'caller',
        providerScope: { origin: 'caller' },
        coralEnv: expect.any(Object),
        networkEnv: { HTTPS_PROXY: 'http://caller-proxy:1234' },
      });
      expect(jobSendSchema.parse(first[1])).toEqual(first[1]);
    },
  );

  it.each([null, {}, { requestedSeq: 2, status: { execution: 1, phase: 'running' } }])(
    'does not send when detail cannot bind the attempt: %j',
    async (detail) => {
      mockState.readStore.jobs.detail.mockReturnValue(detail);
      await expect(
        makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send')).sendJob('job-1', 'input'),
      ).rejects.toThrow();
      expect(mockState.request).not.toHaveBeenCalled();
    },
  );

  it('does not send after a detail read failure', async () => {
    mockState.readStore.jobs.detail.mockImplementation(() => {
      throw new Error('read unavailable');
    });
    await expect(
      makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send')).sendJob('job-1', 'input'),
    ).rejects.toThrow('read unavailable');
    expect(mockState.request).not.toHaveBeenCalled();
  });

  it.each([
    ['Unrecognized key(s) in object: target, providerScope', 'unsupported_by_running_build'],
    ['Invalid input: target', 'invalid_request'],
  ])('maps strict-schema rejection to decisive %s / %s', async (message, code) => {
    mockState.readStore.jobs.detail.mockReturnValue({
      requestedSeq: 2,
      epochKey: 'epoch',
      status: { execution: 1, phase: 'running', provider: 'claude' },
    });
    mockState.request.mockRejectedValueOnce(new IpcRpcError({ code: -32602, message }));
    const result = await makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send')).sendJob('job-1', 'input');
    expect(result).toMatchObject({ state: 'refused', code });
    expect(mockState.request).toHaveBeenCalledTimes(1);
  });

  it('recognizes an older coordinator strict-schema rejection in server validation data', async () => {
    mockState.readStore.jobs.detail.mockReturnValue({
      requestedSeq: 2,
      epochKey: 'epoch',
      status: { execution: 1, phase: 'running', provider: 'claude' },
    });
    mockState.request.mockRejectedValueOnce(
      new IpcRpcError({
        code: -32602,
        message: 'Invalid params',
        data: {
          issues: [
            {
              code: 'unrecognized_keys',
              keys: ['target', 'providerScope', 'coralEnv'],
              path: [],
              message: 'Unrecognized keys',
            },
          ],
          message: 'Unrecognized keys: target, providerScope, coralEnv',
        },
      }),
    );
    expect(
      await makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send')).sendJob('job-1', 'input'),
    ).toMatchObject({ state: 'refused', code: 'unsupported_by_running_build' });
    expect(mockState.request).toHaveBeenCalledTimes(1);
  });

  it('preserves uncertainty when a lost response is followed by a finishing refusal', async () => {
    mockState.readStore.jobs.detail.mockReturnValue({
      requestedSeq: 2,
      epochKey: 'epoch',
      status: { execution: 1, phase: 'running', provider: 'claude' },
    });
    mockState.request
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ state: 'refused', code: 'execution_finishing', reason: 'Finishing.' });
    const result = await makeClient(projectRoot, findCommand(buildProgram(), 'jobs', 'send')).sendJob('job-1', 'input');
    expect(result).toMatchObject({ state: 'refused', code: 'execution_finishing', priorDeliveryUncertain: true });
    expect(formatJobSendResult('job-1', result).text).toContain('earlier invocation may have delivered');
  });
});
