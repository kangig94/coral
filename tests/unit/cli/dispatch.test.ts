import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockState = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  health: vi.fn(async () => ({ components: [] as Array<Record<string, unknown>> })),
  readStore: {
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
  const kb = program.command('kb');
  kb.command('reindex');
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
    projectRoot = makeTempDir();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempDirs.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
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
