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

import { ensure } from '#src/transport/ipc/ensure.js';
import { makeClient } from '#src/cli/dispatch.js';
import { markProviderCommand } from '#src/cli/classify.js';
import { FORWARDED_NETWORK_ENV_KEYS } from '#src/infra/network-env.js';
import { BackendUnreachableError } from '#src/infra/http-errors.js';

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
  jobs.command('detail');
  jobs.command('release');
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
  beforeEach(() => {
    stubNonChildInvocationEnv();
    mockState.discovery.mockReturnValue({ kind: 'missing' });
    mockState.createLiveClient.mockReturnValue({ request: mockState.liveRequest });
    projectRoot = makeTempDir();
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
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs'));
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
    const client = makeClient(projectRoot, findCommand(buildProgram(), 'jobs'));
    await expect(client.listJobs({ mine: true, unwaited: true, allProjects: true })).resolves.toEqual({ jobs: [] });
    expect(ensure).not.toHaveBeenCalled();
    expect(mockState.request).not.toHaveBeenCalled();
    vi.stubEnv('CORAL_OWNER', undefined);
    await expect(makeClient(projectRoot, findCommand(buildProgram(), 'jobs')).listJobs({ mine: true })).rejects.toThrow(
      'Set CORAL_OWNER',
    );
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
