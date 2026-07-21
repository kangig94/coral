import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockState = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  health: vi.fn(async () => ({ components: [] as Array<Record<string, unknown>> })),
  shutdownAndAwaitRelease: vi.fn(async () => {}),
  readStore: {
    discuss: {
      watch: vi.fn(),
    },
  },
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-cli-provider-scope-'));
  tempDirs.push(root);
  return root;
}

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: vi.fn(async () => ({
    request: mockState.request,
    subscribe: mockState.subscribe,
    health: mockState.health,
  })),
  shutdownAndAwaitRelease: mockState.shutdownAndAwaitRelease,
}));

vi.mock('#src/cli/read-store.js', () => ({
  getSharedReadCoralStore: vi.fn(() => mockState.readStore),
}));

import { ensure } from '#src/transport/ipc/ensure.js';
import { makeClient } from '#src/cli/dispatch.js';
import { markProviderCommand } from '#src/cli/classify.js';
import { KB_DISABLED_REASON } from '#src/infra/kb-toggle.js';
import { FORWARDED_NETWORK_ENV_KEYS } from '#src/infra/network-env.js';

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
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempDirs.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('captures caller-default Claude as an explicit physical profile without requiring Codex', async () => {
    const callerHome = makeTempDir();
    const physicalClaude = join(callerHome, 'physical-claude');
    const callerDefaultClaude = join(callerHome, '.claude');
    mkdirSync(physicalClaude);
    symlinkSync(physicalClaude, callerDefaultClaude, 'dir');
    vi.stubEnv('HOME', callerHome);
    vi.stubEnv('USERPROFILE', '');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('CODEX_HOME', join(callerHome, 'absent-codex'));
    vi.stubEnv(
      'CORAL_SYSTEM_PROVIDER_SCOPE',
      JSON.stringify({
        origin: 'system',
        name: 'daemon-account',
        profiles: [{ provider: 'claude', profile: { canonicalLocation: '/daemon/.claude', routing: {} } }],
      }),
    );
    mockState.request.mockResolvedValueOnce({ job: 'session-job' });
    const client = makeClient('/tmp/project', findCommand(buildProgram(), 'claude'));

    await client.createSession('claude', 'hi', {});

    const [, body] = mockState.request.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.providerScope).toEqual({
      origin: 'caller',
      profiles: [
        {
          provider: 'claude',
          profile: {
            canonicalLocation: realpathSync(physicalClaude),
            routing: { kind: 'config-dir', emitConfigDir: false, homeDir: callerHome },
          },
        },
      ],
    });
  });

  it('canonicalizes the explicit caller Codex profile without requiring Claude', async () => {
    const callerHome = makeTempDir();
    const physicalCodex = join(callerHome, 'physical-codex');
    const selectedCodex = join(callerHome, 'selected-codex');
    mkdirSync(physicalCodex);
    symlinkSync(physicalCodex, selectedCodex, 'dir');
    vi.stubEnv('HOME', callerHome);
    vi.stubEnv('CODEX_HOME', selectedCodex);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(callerHome, 'absent-claude'));
    mockState.request.mockResolvedValueOnce({ job: 'session-job' });
    const client = makeClient('/tmp/project', findCommand(buildProgram(), 'claude'));

    await client.createSession('codex', 'hi', {});

    const [, body] = mockState.request.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.providerScope).toEqual({
      origin: 'caller',
      profiles: [
        {
          provider: 'codex',
          profile: { canonicalLocation: realpathSync(physicalCodex), routing: { kind: 'home' } },
        },
      ],
    });
  });

  it('captures every provider referenced by a mixed-provider workflow', async () => {
    const callerHome = makeTempDir();
    const codexHome = join(callerHome, 'codex');
    const claudeHome = join(callerHome, 'claude');
    mkdirSync(codexHome);
    mkdirSync(claudeHome);
    vi.stubEnv('HOME', callerHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome);
    mockState.request.mockResolvedValueOnce({ job: 'workflow-job' });
    const client = makeClient('/tmp/project', findCommand(buildProgram(), 'workflow'));

    await client.workflow('architect@claude -> resolver@codex', { provider: 'claude', startPrompt: 'seed' });

    const [, body] = mockState.request.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.providerScope).toMatchObject({
      origin: 'caller',
      profiles: [
        { provider: 'claude', profile: { canonicalLocation: realpathSync(claudeHome) } },
        { provider: 'codex', profile: { canonicalLocation: realpathSync(codexHome) } },
      ],
    });
  });

  it('forwards the caller shell proxy/CA env to provider launches as networkEnv', async () => {
    for (const key of FORWARDED_NETWORK_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    vi.stubEnv('HTTP_PROXY', 'http://proxy:8080');
    vi.stubEnv('NO_PROXY', 'localhost');
    mockState.request.mockResolvedValueOnce({ job: 'session-job' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'claude'));

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

  it('omits networkEnv when no proxy/CA env is set', async () => {
    // Clear every forwarded key — a stray lowercase proxy var in the runner's
    // real shell would otherwise populate networkEnv and flake this assertion.
    for (const key of FORWARDED_NETWORK_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    mockState.request.mockResolvedValueOnce({ job: 'session-job' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'claude'));

    await client.createSession('claude', 'hi', {});

    const [, body] = mockState.request.mock.calls[0];
    expect(body).not.toHaveProperty('networkEnv');
  });

  it('forwards networkEnv on the workflow launch path', async () => {
    for (const key of FORWARDED_NETWORK_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
    vi.stubEnv('HTTPS_PROXY', 'http://proxy:8443');
    vi.stubEnv('CLAUDE_CONFIG_DIR', makeTempDir());
    mockState.request.mockResolvedValueOnce({ job: 'workflow-job' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'workflow'));

    await client.workflow('agent', { startPrompt: 'go' });

    expect(mockState.request).toHaveBeenCalledWith(
      'workflow.run',
      expect.objectContaining({ networkEnv: { HTTPS_PROXY: 'http://proxy:8443' } }),
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
    const client = makeClient('/tmp/project', findCommand(program, 'claude'));

    await client.createSession('claude', 'hi', {});

    const [, body] = mockState.request.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.coralEnv).toMatchObject({ CORAL_CODEX_MODEL: 'gpt-5.6-sol' });
    expect(body.coralEnv).not.toHaveProperty('CORAL_ENV_PASSTHROUGH');
  });

  it('forwards coralEnv on the workflow launch path', async () => {
    vi.stubEnv('CORAL_CODEX_MODEL', 'gpt-5.6-sol');
    mockState.request.mockResolvedValueOnce({ job: 'workflow-job' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'workflow'));

    await client.workflow('agent', { startPrompt: 'go' });

    const [, body] = mockState.request.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.coralEnv).toMatchObject({ CORAL_CODEX_MODEL: 'gpt-5.6-sol' });
  });

  it('omits projectRoot from jobs.list when listing across all projects', async () => {
    mockState.request.mockResolvedValueOnce({ jobs: [] });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'claude'));

    await client.listJobs({ allProjects: true, phase: 'running' });

    // The bare `coral jobs` listing must reach the backend unscoped so every
    // project's jobs (and KB jobs) surface regardless of cwd.
    expect(mockState.request).toHaveBeenCalledWith(
      'jobs.list',
      { phase: 'running' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('scopes jobs.list to the caller project root by default', async () => {
    mockState.request.mockResolvedValueOnce({ jobs: [] });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'claude'));

    await client.listJobs({ phase: 'running' });

    expect(mockState.request).toHaveBeenCalledWith(
      'jobs.list',
      { projectRoot: '/tmp/project', phase: 'running' },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('dispatches jobs.detail with the caller project root', async () => {
    mockState.request.mockResolvedValueOnce({ status: { jobId: 'job-1' }, events: [], readiness: 'ready', exit: null });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'jobs', 'detail'));

    await client.detailJob('job-1');

    expect(mockState.request).toHaveBeenCalledWith(
      'jobs.detail',
      { jobId: 'job-1', projectRoot: '/tmp/project' },
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
    const client = makeClient('/tmp/project', findCommand(program, 'discuss', 'watch'));

    await expect(client.discussWatch('discuss-1', 3)).resolves.toBe(watchState);

    expect(mockState.readStore.discuss.watch).toHaveBeenCalledWith('discuss-1', 3);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('forwards kb search mode through transport dispatchers', async () => {
    mockState.request.mockResolvedValueOnce({ results: [], mode: 'vector' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'kb', 'reindex'));

    await client.kbSearch({
      query: 'contracts',
      top_k: 5,
      scope: 'notes',
      mode: 'vector',
    });

    expect(mockState.request).toHaveBeenCalledWith(
      'kb.entries.search',
      {
        q: 'contracts',
        scope: 'notes',
        top_k: 5,
        mode: 'vector',
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('dispatches kb diagnose over the transport surface for non-read clients', async () => {
    mockState.request.mockResolvedValueOnce({ incidents: [] });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'kb', 'reindex'));

    await client.kbDiagnose({});

    expect(mockState.request).toHaveBeenCalledWith(
      'kb.diagnose',
      {},
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('renames the kb update note slug to `slug` without leaking the `note` key', async () => {
    mockState.request.mockResolvedValueOnce({ path: '/kb/notes/coral-kb-read.md' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'kb', 'reindex'));

    await client.kbUpdate({ note: 'coral-kb-read', content: 'updated body\n' });

    expect(mockState.request).toHaveBeenCalledWith(
      'kb.note.update',
      expect.objectContaining({
        slug: 'coral-kb-read',
        content: 'updated body\n',
        projectRoot: '/tmp/project',
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    const [, body] = mockState.request.mock.calls[0];
    expect(body).not.toHaveProperty('note');
  });

  it('forwards kb reindex request arguments through transport dispatch', async () => {
    mockState.request.mockResolvedValueOnce({ status: 'running', job: 'kb-reindex-job' });
    const program = buildProgram();
    const client = makeClient('/tmp/project', findCommand(program, 'kb', 'reindex'));

    await client.kbReindex({ async: true });

    expect(mockState.request).toHaveBeenCalledWith(
      'kb.reindex',
      expect.objectContaining({
        async: true,
        projectRoot: '/tmp/project',
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });
});

describe('kb lazy reconcile', () => {
  const prevKbEnabled = process.env.CORAL_KB_ENABLE;

  beforeEach(() => {
    stubNonChildInvocationEnv();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (prevKbEnabled === undefined) {
      delete process.env.CORAL_KB_ENABLE;
    } else {
      process.env.CORAL_KB_ENABLE = prevKbEnabled;
    }
    vi.unstubAllEnvs();
  });

  it('restarts the daemon when a kb command runs with KB enabled against a KB-disabled daemon', async () => {
    process.env.CORAL_KB_ENABLE = '1';
    mockState.health.mockResolvedValueOnce({
      components: [{ id: 'kb', phase: 'offline', reason: KB_DISABLED_REASON }],
    });
    mockState.request.mockResolvedValueOnce({ status: 'running' });
    const client = makeClient('/tmp/project', findCommand(buildProgram(), 'kb', 'reindex'));

    await client.kbReindex({ async: true });

    expect(mockState.shutdownAndAwaitRelease).toHaveBeenCalledTimes(1);
  });

  it('does not restart when the daemon already has KB online', async () => {
    process.env.CORAL_KB_ENABLE = '1';
    mockState.health.mockResolvedValueOnce({ components: [{ id: 'kb', phase: 'online' }] });
    mockState.request.mockResolvedValueOnce({ status: 'running' });
    const client = makeClient('/tmp/project', findCommand(buildProgram(), 'kb', 'reindex'));

    await client.kbReindex({ async: true });

    expect(mockState.shutdownAndAwaitRelease).not.toHaveBeenCalled();
  });

  it('does not probe or restart when the caller wants KB disabled', async () => {
    process.env.CORAL_KB_ENABLE = '0';
    mockState.request.mockResolvedValueOnce({ status: 'running' });
    const client = makeClient('/tmp/project', findCommand(buildProgram(), 'kb', 'reindex'));

    await client.kbReindex({ async: true });

    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.shutdownAndAwaitRelease).not.toHaveBeenCalled();
  });

  it('falls through to the command when the health probe fails', async () => {
    process.env.CORAL_KB_ENABLE = '1';
    mockState.health.mockRejectedValueOnce(new Error('unreachable'));
    mockState.request.mockResolvedValueOnce({ status: 'running' });
    const client = makeClient('/tmp/project', findCommand(buildProgram(), 'kb', 'reindex'));

    await client.kbReindex({ async: true });

    expect(mockState.shutdownAndAwaitRelease).not.toHaveBeenCalled();
    expect(mockState.request).toHaveBeenCalled();
  });
});
