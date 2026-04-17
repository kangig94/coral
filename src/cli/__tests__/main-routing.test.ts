import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MainMod from '../main.js';

const mockState = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  workflow: vi.fn(),
  listJobs: vi.fn(),
  abortJobs: vi.fn(),
  launchAndFollow: vi.fn(),
  ensureBackend: vi.fn(),
  getBackendStatusFull: vi.fn(),
  shutdownBackend: vi.fn(),
  streamWait: vi.fn(),
  discussSeed: vi.fn(),
  discussStart: vi.fn(),
  discussWatch: vi.fn(),
  discussBid: vi.fn(),
  discussSpeech: vi.fn(),
  discussAbort: vi.fn(),
  kbSearch: vi.fn(),
  kbPrinciples: vi.fn(),
  kbMemo: vi.fn(),
  kbMemoList: vi.fn(),
  kbMemoDelete: vi.fn(),
  kbMemoPurge: vi.fn(),
  kbRead: vi.fn(),
  kbPromote: vi.fn(),
  kbUpdate: vi.fn(),
  kbDelete: vi.fn(),
  kbReindex: vi.fn(),
}));

vi.mock('../../client/http-client.js', () => {
  class BackendToolHttpError extends Error {
    statusCode: number;
    body: unknown;

    constructor(message: string, statusCode: number, body: unknown) {
      super(message);
      this.statusCode = statusCode;
      this.body = body;
    }
  }

  class BackendClient {
    createSession = mockState.createSession;
    sendMessage = mockState.sendMessage;
    workflow = mockState.workflow;
    listJobs = mockState.listJobs;
    abortJobs = mockState.abortJobs;
    discussSeed = mockState.discussSeed;
    discussStart = mockState.discussStart;
    discussWatch = mockState.discussWatch;
    discussBid = mockState.discussBid;
    discussSpeech = mockState.discussSpeech;
    discussAbort = mockState.discussAbort;
    kbSearch = mockState.kbSearch;
    kbPrinciples = mockState.kbPrinciples;
    kbMemo = mockState.kbMemo;
    kbMemoList = mockState.kbMemoList;
    kbMemoDelete = mockState.kbMemoDelete;
    kbMemoPurge = mockState.kbMemoPurge;
    kbRead = mockState.kbRead;
    kbPromote = mockState.kbPromote;
    kbUpdate = mockState.kbUpdate;
    kbDelete = mockState.kbDelete;
    kbReindex = mockState.kbReindex;

    constructor(_options: unknown) {}
  }

  return { BackendClient, BackendToolHttpError };
});

vi.mock('../../client/backend-lifecycle.js', () => ({
  ensureBackend: mockState.ensureBackend,
}));

vi.mock('../../client/backend-helpers.js', () => ({
  getBackendStatusFull: mockState.getBackendStatusFull,
  shutdownBackend: mockState.shutdownBackend,
  streamWait: mockState.streamWait,
}));

vi.mock('../follow.js', () => ({
  launchAndFollow: mockState.launchAndFollow,
}));

type MainModule = typeof MainMod;

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function loadMainModule(): Promise<MainModule> {
  vi.resetModules();
  return import('../main.js');
}

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

function makeJobsListResponse(jobIds: string[], overrides: { phase?: string; provider?: string } = {}) {
  const phase = overrides.phase ?? 'running';
  const provider = overrides.provider ?? 'codex';

  return {
    jobs: jobIds.map((jobId, index) => ({
      jobId,
      status: {
        provider,
        phase,
        projectRoot: process.cwd(),
        launch: {
          updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        },
      },
    })),
  };
}

describe('cli main routing', () => {
  let stdout = '';
  let stderr = '';
  let originalArgv: string[];
  const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');

  function restoreStdin(): void {
    if (originalStdinDescriptor) {
      Object.defineProperty(process, 'stdin', originalStdinDescriptor);
    }
  }

  beforeEach(() => {
    stdout = '';
    stderr = '';
    originalArgv = [...process.argv];
    process.exitCode = undefined;

    mockState.createSession.mockReset();
    mockState.sendMessage.mockReset();
    mockState.workflow.mockReset();
    mockState.listJobs.mockReset();
    mockState.abortJobs.mockReset();
    mockState.launchAndFollow.mockReset();
    mockState.ensureBackend.mockReset();
    mockState.getBackendStatusFull.mockReset();
    mockState.shutdownBackend.mockReset();
    mockState.streamWait.mockReset();
    mockState.discussSeed.mockReset();
    mockState.discussStart.mockReset();
    mockState.discussWatch.mockReset();
    mockState.discussBid.mockReset();
    mockState.discussSpeech.mockReset();
    mockState.discussAbort.mockReset();
    mockState.kbSearch.mockReset();
    mockState.kbPrinciples.mockReset();
    mockState.kbMemo.mockReset();
    mockState.kbMemoList.mockReset();
    mockState.kbMemoDelete.mockReset();
    mockState.kbMemoPurge.mockReset();
    mockState.kbRead.mockReset();
    mockState.kbPromote.mockReset();
    mockState.kbUpdate.mockReset();
    mockState.kbDelete.mockReset();
    mockState.kbReindex.mockReset();

    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += toText(chunk);
      return true;
    }) as typeof process.stdout.write);

    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += toText(chunk);
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    restoreStdin();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('exposes a reusable program factory', async () => {
    const { buildProgram } = await loadMainModule();

    const program = buildProgram();

    expect(program.name()).toBe('coral-cli');
    expect(program.commands.find((command) => command.name() === 'simulate')).toBeDefined();
    expect(program.commands.find((command) => command.name() === 'wait')).toBeDefined();
  });

  it('preserves top-level help output via snapshot', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    expect(program.helpInformation()).toMatchSnapshot();
  });

  it.each([
    { label: 'codex', path: ['codex'] },
    { label: 'workflow', path: ['workflow'] },
    { label: 'backend', path: ['backend'] },
    { label: 'discuss', path: ['discuss'] },
    { label: 'kb', path: ['kb'] },
    { label: 'kb source', path: ['kb', 'source'] },
    { label: 'kb memo', path: ['kb', 'memo'] },
  ])('preserves help output for $label via snapshot', async ({ path }) => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const command = findCommand(program, ...path);

    expect(command.helpInformation()).toMatchSnapshot();
  });

  it('routes jobs --phase through filtered job lookup and projected json output', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    mockState.listJobs.mockResolvedValueOnce(makeJobsListResponse(['job-1'], { phase: 'running' }));

    await program.parseAsync(['node', 'coral-cli', 'jobs', '--phase', 'running', '--output-format', 'json']);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      phase: 'running',
    });
    expect(JSON.parse(stdout.trim())).toEqual([
      {
        jobId: 'job-1',
        phase: 'running',
        provider: 'codex',
        cwd: process.cwd(),
        age: '2d ago',
      },
    ]);
    expect(stderr).toBe('');
  });

  it('routes jobs --provider through filtered job lookup and projected json output', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    mockState.listJobs.mockResolvedValueOnce(makeJobsListResponse(['job-2'], { provider: 'claude' }));

    await program.parseAsync(['node', 'coral-cli', 'jobs', '--provider', 'claude', '--output-format', 'json']);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      provider: 'claude',
    });
    expect(JSON.parse(stdout.trim())).toEqual([
      {
        jobId: 'job-2',
        phase: 'running',
        provider: 'claude',
        cwd: process.cwd(),
        age: '2d ago',
      },
    ]);
    expect(stderr).toBe('');
  });

  it('routes jobs --all through all-phase job lookup and projected json output', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    mockState.listJobs.mockResolvedValueOnce(
      makeJobsListResponse(['job-3'], { phase: 'completed', provider: 'claude' }),
    );

    await program.parseAsync(['node', 'coral-cli', 'jobs', '--all', '--output-format', 'json']);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      all: true,
    });
    expect(JSON.parse(stdout.trim())).toEqual([
      {
        jobId: 'job-3',
        phase: 'completed',
        provider: 'claude',
        cwd: process.cwd(),
        age: '2d ago',
      },
    ]);
    expect(stderr).toBe('');
  });

  it('returns a usage error for jobs --phase combined with --all', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync([
      'node',
      'coral-cli',
      'jobs',
      '--phase',
      'running',
      '--all',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--phase cannot be used with --all',
    });
    expect(process.exitCode).toBe(2);
  });

  it('renders a no-match message when jobs lookup returns zero rows', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.listJobs.mockResolvedValueOnce({ jobs: [] });

    await program.parseAsync(['node', 'coral-cli', 'jobs', '--provider', 'codex']);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      provider: 'codex',
    });
    expect(stdout).toBe('No jobs match current project, live phases, provider=codex\n');
    expect(stderr).toBe('');
  });

  it('routes abort --jobs through exact pass-through targeting', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.abortJobs.mockResolvedValueOnce({
      aborted: ['job-1', 'job-2'],
      notFound: [],
    });

    await program.parseAsync(['node', 'coral-cli', 'abort', '--jobs', 'job-1,job-2', '--output-format', 'json']);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).toHaveBeenCalledWith(['job-1', 'job-2']);
    expect(JSON.parse(stdout.trim())).toEqual({
      aborted: ['job-1', 'job-2'],
      notFound: [],
    });
    expect(stderr).toBe('');
  });

  it('routes abort --all through live job lookup for the current project', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.listJobs.mockResolvedValueOnce(makeJobsListResponse(['job-1', 'job-2']));
    mockState.abortJobs.mockResolvedValueOnce({
      aborted: ['job-1', 'job-2'],
      notFound: [],
    });

    await program.parseAsync(['node', 'coral-cli', 'abort', '--all', '--output-format', 'json']);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      all: false,
    });
    expect(mockState.abortJobs).toHaveBeenCalledWith(['job-1', 'job-2']);
    expect(JSON.parse(stdout.trim())).toEqual({
      aborted: ['job-1', 'job-2'],
      notFound: [],
    });
    expect(stderr).toBe('');
  });

  it('routes abort --phase running through live job lookup for the current project', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.listJobs.mockResolvedValueOnce(makeJobsListResponse(['job-1'], { phase: 'running' }));
    mockState.abortJobs.mockResolvedValueOnce({
      aborted: ['job-1'],
      notFound: [],
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--phase',
      'running',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      phase: 'running',
      all: false,
    });
    expect(mockState.abortJobs).toHaveBeenCalledWith(['job-1']);
    expect(JSON.parse(stdout.trim())).toEqual({
      aborted: ['job-1'],
      notFound: [],
    });
    expect(stderr).toBe('');
  });

  it('routes abort --phase running --provider codex through intersected live job lookup', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.listJobs.mockResolvedValueOnce(
      makeJobsListResponse(['job-1'], { phase: 'running', provider: 'codex' }),
    );
    mockState.abortJobs.mockResolvedValueOnce({
      aborted: ['job-1'],
      notFound: [],
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--phase',
      'running',
      '--provider',
      'codex',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      phase: 'running',
      provider: 'codex',
      all: false,
    });
    expect(mockState.abortJobs).toHaveBeenCalledWith(['job-1']);
    expect(JSON.parse(stdout.trim())).toEqual({
      aborted: ['job-1'],
      notFound: [],
    });
    expect(stderr).toBe('');
  });

  it('returns a usage error when abort selector is omitted', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync(['node', 'coral-cli', 'abort', '--output-format', 'json']);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--jobs, --all, --phase, or --provider is required',
    });
    expect(process.exitCode).toBe(2);
  });

  it('returns a usage error for abort --phase completed', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync(['node', 'coral-cli', 'abort', '--phase', 'completed', '--output-format', 'json']);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--phase must be one of: queued, launching, running',
    });
    expect(process.exitCode).toBe(2);
  });

  it('returns a usage error for abort with an unregistered provider', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--provider',
      'unknown',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--provider must be one of: codex, claude',
    });
    expect(process.exitCode).toBe(2);
  });

  it('returns a usage error for abort --all combined with --provider', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--all',
      '--provider',
      'codex',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--all cannot be used with --phase or --provider',
    });
    expect(process.exitCode).toBe(2);
  });

  it('returns a usage error for abort --jobs combined with --all', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--jobs',
      'job-1',
      '--all',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--jobs cannot be used with --all, --phase, or --provider',
    });
    expect(process.exitCode).toBe(2);
  });

  it('returns a usage error for abort --jobs combined with --phase', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--jobs',
      'job-1',
      '--phase',
      'running',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--jobs cannot be used with --all, --phase, or --provider',
    });
    expect(process.exitCode).toBe(2);
  });

  it('returns a usage error for abort --jobs combined with --provider', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--jobs',
      'job-1',
      '--provider',
      'codex',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({
      error: true,
      code: 'invalid_usage',
      message: '--jobs cannot be used with --all, --phase, or --provider',
    });
    expect(process.exitCode).toBe(2);
  });

  it('skips backend abort when a query selector matches zero live jobs', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.listJobs.mockResolvedValueOnce({ jobs: [] });

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--provider',
      'codex',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      provider: 'codex',
      all: false,
    });
    expect(mockState.abortJobs).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.trim())).toEqual({
      aborted: [],
      notFound: [],
    });
    expect(stderr).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves exact abort partial misses as a pass-through result', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.abortJobs.mockResolvedValueOnce({
      aborted: ['job-live'],
      notFound: ['job-terminal'],
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'abort',
      '--jobs',
      'job-live,job-terminal',
      '--output-format',
      'json',
    ]);

    expect(mockState.listJobs).not.toHaveBeenCalled();
    expect(mockState.abortJobs).toHaveBeenCalledWith(['job-live', 'job-terminal']);
    expect(JSON.parse(stdout.trim())).toEqual({
      aborted: ['job-live'],
      notFound: ['job-terminal'],
    });
    expect(stderr).toBe('');
  });

  it('routes simulate to the scenario runner command surface', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const scenarioFile = join(tmpdir(), `coral-simulate-${Date.now()}.yaml`);

    writeFileSync(
      scenarioFile,
      ['world: {}', 'steps:', '  - type: expect', '    jobCount: 0'].join('\n'),
      'utf8',
    );

    try {
      await program.parseAsync(['node', 'coral-cli', 'simulate', scenarioFile]);

      expect(stdout).toContain('PASS 0 expect');
      expect(stdout).toContain('Scenario passed');
      expect(stderr).toBe('');
      expect(process.exitCode).toBe(0);
    } finally {
      unlinkSync(scenarioFile);
    }
  });

  it('uses flattened provider commands with unified flags and workflow start-prompt help', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const codex = program.commands.find((command) => command.name() === 'codex');
    const workflow = program.commands.find((command) => command.name() === 'workflow');

    expect(codex?.commands).toHaveLength(0);
    expect(codex?.helpInformation()).toContain('-i, --input');
    expect(codex?.helpInformation()).toContain('-b, --bypass-permissions');
    expect(codex?.helpInformation()).toContain('-d, --detach');
    expect(workflow?.helpInformation()).toContain('--detach');
    expect(workflow?.helpInformation()).toContain('-s, --start-prompt');
  });

  it('passes unified flags through raw provider launches and resolves -i file input', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const inputFile = join(tmpdir(), `coral-provider-input-${Date.now()}.txt`);

    writeFileSync(inputFile, 'prompt from file');
    try {
      mockState.sendMessage.mockResolvedValueOnce({
        launchState: 'running',
        job: 'job-1',
        session: 'session-1',
      });
      mockState.launchAndFollow.mockResolvedValueOnce(7);

      await program.parseAsync([
        'node',
        'coral-cli',
        'codex',
        '-i',
        inputFile,
        '-s',
        'session-1',
        '-w',
        '/tmp/work',
        '-m',
        'gpt-5',
        '-o',
        'owner-1',
        '-b',
        '-f',
        'json',
      ]);

      expect(mockState.sendMessage).toHaveBeenCalledWith('session-1', 'prompt from file', {
        workDir: '/tmp/work',
        model: 'gpt-5',
        owner: 'owner-1',
        bypassPermissions: true,
        provider: 'codex',
      });
      expect(mockState.launchAndFollow).toHaveBeenCalledWith({
        launchResult: {
          launchState: 'running',
          job: 'job-1',
          session: 'session-1',
        },
        abortJob: expect.any(Function),
        pluginRoot: expect.any(String),
        projectRoot: process.cwd(),
        outputFormat: 'json',
        emitError: expect.any(Function),
        isTTY: process.stdout.isTTY === true,
        columns: process.stdout.columns ?? 80,
      });
      expect(process.exitCode).toBe(7);
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    } finally {
      unlinkSync(inputFile);
    }
  });

  it('treats a non-existent -i path as literal text for raw provider launches', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const missingInput = join(tmpdir(), `coral-missing-input-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);

    mockState.sendMessage.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-raw-text',
      session: 'session-raw-text',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync([
      'node',
      'coral-cli',
      'codex',
      '-i',
      missingInput,
      '-s',
      'session-raw-text',
    ]);

    expect(mockState.sendMessage).toHaveBeenCalledWith('session-raw-text', missingInput, {
      provider: 'codex',
    });
  });

  it('injects the claude provider into resume requests', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.sendMessage.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-claude-resume',
      session: 'session-claude-resume',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync(['node', 'coral-cli', 'claude', '-i', 'hi', '-s', 'session-claude-resume']);

    expect(mockState.sendMessage).toHaveBeenCalledWith('session-claude-resume', 'hi', {
      provider: 'claude',
    });
  });

  it('keeps provider positional for createSession and does not duplicate it in options', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.createSession.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-create-raw',
      session: 'session-create-raw',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync(['node', 'coral-cli', 'codex', '-i', 'hi']);

    expect(mockState.createSession).toHaveBeenCalledWith('codex', 'hi', {});
  });

  it.each([
    ['architect', 'architect'],
    ['coral:architect', 'coral:architect'],
    ['project:my-local', 'project:my-local'],
    ['other:agent', 'other:agent'],
  ])('dispatches provider agent launches with full op preservation for %s', async (agent, expectedOp) => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.createSession.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-1',
      session: 'session-1',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync([
      'node',
      'coral-cli',
      'codex',
      agent,
      '-i',
      'hi',
      '-w',
      '/tmp/work',
      '-m',
      'gpt-5',
      '-o',
      'owner-1',
      '-b',
    ]);

    expect(mockState.createSession).toHaveBeenCalledWith('codex', 'hi', {
      agent: expectedOp,
      workDir: '/tmp/work',
      model: 'gpt-5',
      owner: 'owner-1',
      bypassPermissions: true,
    });
  });

  it('preserves explicit coral:architect for codex agent launches', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.createSession.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-coral-architect',
      session: 'session-coral-architect',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync(['node', 'coral-cli', 'codex', 'coral:architect', '-i', 'hi']);

    expect(mockState.createSession).toHaveBeenCalledWith('codex', 'hi', { agent: 'coral:architect' });
  });

  it('preserves explicit coral:debugger for codex agent launches', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.createSession.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-coral-debugger',
      session: 'session-coral-debugger',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync(['node', 'coral-cli', 'codex', 'coral:debugger', '-i', 'hi']);

    expect(mockState.createSession).toHaveBeenCalledWith('codex', 'hi', { agent: 'coral:debugger' });
  });

  it('dispatches provider agent launches for the claude provider', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.createSession.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-claude',
      session: 'session-claude',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync(['node', 'coral-cli', 'claude', 'debugger', '-i', 'hi']);

    expect(mockState.createSession).toHaveBeenCalledWith('claude', 'hi', { agent: 'debugger' });
  });

  it('keeps detach launches on the one-shot path and honors -f json', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.createSession.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-1',
      session: 'session-1',
    });

    await program.parseAsync(['node', 'coral-cli', 'codex', '-i', 'hi', '--detach', '-f', 'json']);

    expect(JSON.parse(stdout.trim())).toEqual({
      launchState: 'running',
      job: 'job-1',
      session: 'session-1',
    });
    expect(stderr).toBe('');
    expect(mockState.launchAndFollow).not.toHaveBeenCalled();
  });

  it('treats domain launch failures as tool errors and does not follow them', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    const { BackendToolHttpError } = await import('../../client/http-client.js');
    mockState.createSession.mockRejectedValueOnce(
      new BackendToolHttpError('HTTP 400', 400, { code: 'bad_request', message: 'Missing prompt' }),
    );

    await program.parseAsync(['node', 'coral-cli', 'codex', '-i', 'hi']);

    expect(stdout).toBe('');
    expect(stderr).toBe('HTTP 400: {"code":"bad_request","message":"Missing prompt"}\n');
    expect(process.exitCode).toBe(1);
    expect(mockState.launchAndFollow).not.toHaveBeenCalled();
  });

  it('routes workflow launches into launchAndFollow by default', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const promptFile = join(tmpdir(), `coral-workflow-prompt-${Date.now()}.txt`);
    const contextFile = join(tmpdir(), `coral-workflow-context-${Date.now()}.txt`);

    writeFileSync(promptFile, 'workflow start');
    writeFileSync(contextFile, 'workflow context');
    try {
      mockState.workflow.mockResolvedValueOnce({
        launchState: 'queued',
        job: 'job-2',
        session: 'session-2',
      });
      mockState.launchAndFollow.mockResolvedValueOnce(0);

      await program.parseAsync([
        'node',
        'coral-cli',
        'workflow',
        '-e',
        '(architect)',
        '-s',
        promptFile,
        '-c',
        contextFile,
        '-p',
        'codex',
        '-w',
        '/tmp/workflow',
        '-o',
        'owner-1',
        '-f',
        'json',
      ]);

      expect(mockState.workflow).toHaveBeenCalledWith('(architect)', {
        startPrompt: 'workflow start',
        context: 'workflow context',
        provider: 'codex',
        workDir: '/tmp/workflow',
        owner: 'owner-1',
      });
      expect(mockState.launchAndFollow).toHaveBeenCalledWith({
        launchResult: {
          launchState: 'queued',
          job: 'job-2',
          session: 'session-2',
        },
        abortJob: expect.any(Function),
        pluginRoot: expect.any(String),
        projectRoot: process.cwd(),
        outputFormat: 'json',
        emitError: expect.any(Function),
        isTTY: process.stdout.isTTY === true,
        columns: process.stdout.columns ?? 80,
      });
      expect(process.exitCode).toBe(0);
    } finally {
      unlinkSync(promptFile);
      unlinkSync(contextFile);
    }
  });

  it('joins variadic -i tokens into a single prompt for provider launches', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.createSession.mockResolvedValueOnce({
      launchState: 'running',
      job: 'job-variadic',
      session: 'session-variadic',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync(['node', 'coral-cli', 'codex', 'architect', '-i', 'check', 'func(x)', 'behavior']);

    expect(mockState.createSession).toHaveBeenCalledWith('codex', 'check func(x) behavior', {
      agent: 'architect',
    });
  });

  it('joins the contents of multiple variadic -i file paths', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const randomSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const firstFile = join(tmpdir(), `coral-variadic-first-${randomSuffix}.txt`);
    const secondFile = join(tmpdir(), `coral-variadic-second-${randomSuffix}.txt`);

    writeFileSync(firstFile, 'first content');
    writeFileSync(secondFile, 'second content');
    try {
      mockState.createSession.mockResolvedValueOnce({
        launchState: 'running',
        job: 'job-multi-file',
        session: 'session-multi-file',
      });
      mockState.launchAndFollow.mockResolvedValueOnce(0);

      await program.parseAsync([
        'node',
        'coral-cli',
        'codex',
        'architect',
        '-i',
        firstFile,
        secondFile,
      ]);

      expect(mockState.createSession).toHaveBeenCalledWith('codex', 'first content second content', {
        agent: 'architect',
      });
    } finally {
      unlinkSync(firstFile);
      unlinkSync(secondFile);
    }
  });

  it('reads a hook-materialized temp file alongside literal tokens passed as variadic -i values', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const materializedPromptFile = join(
      tmpdir(),
      `coral-materialized-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );

    writeFileSync(materializedPromptFile, 'hello');
    try {
      mockState.createSession.mockResolvedValueOnce({
        launchState: 'running',
        job: 'job-mixed',
        session: 'session-mixed',
      });
      mockState.launchAndFollow.mockResolvedValueOnce(0);

      await program.parseAsync([
        'node',
        'coral-cli',
        'codex',
        'architect',
        '-i',
        materializedPromptFile,
        'func(x)',
      ]);

      expect(mockState.createSession).toHaveBeenCalledWith('codex', 'hello func(x)', {
        agent: 'architect',
      });
    } finally {
      unlinkSync(materializedPromptFile);
    }
  });

  it('joins variadic workflow -s and -c tokens into single fields', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.workflow.mockResolvedValueOnce({
      launchState: 'queued',
      job: 'job-workflow-variadic',
      session: 'session-workflow-variadic',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync([
      'node',
      'coral-cli',
      'workflow',
      '-e',
      '(architect)',
      '-s',
      'start',
      'the',
      'thing',
      '-c',
      'shared',
      'ctx',
    ]);

    expect(mockState.workflow).toHaveBeenCalledWith('(architect)', {
      startPrompt: 'start the thing',
      context: 'shared ctx',
    });
  });

  it('keeps successful wait NDJSON on stdout and leaves stderr empty', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.ensureBackend.mockResolvedValueOnce({
      host: '127.0.0.1',
      port: 4100,
      token: 'backend-token',
    });
    mockState.streamWait.mockImplementationOnce(async function* () {
      yield {
        type: 'progress',
        jobId: 'job-1',
        eventId: 1,
        message: 'working',
      };
      yield {
        type: 'terminal',
        jobId: 'job-1',
        remainingJobIds: [],
        resultPath: '/tmp/result.md',
        result: { content: 'done', exitCode: 0 },
      };
    });

    await program.parseAsync(['node', 'coral-cli', 'wait', '--jobs', 'job-1', '--output-format', 'json']);

    expect(stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      {
        cursor: null,
        event: {
          type: 'progress',
          jobId: 'job-1',
          eventId: 1,
          message: 'working',
        },
      },
      {
        cursor: null,
        event: {
          type: 'terminal',
          jobId: 'job-1',
          remainingJobIds: [],
          result: {
            path: '/tmp/result.md',
            exitCode: 0,
          },
        },
      },
    ]);
    expect(stderr).toBe('');
  });

  it('treats discuss backend_recovering results as command errors without relying on thrown HTTP errors', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const errorBody = {
      code: 'backend_recovering',
      message: 'recovering — retry after 500ms',
    };

    const { BackendToolHttpError } = await import('../../client/http-client.js');
    mockState.discussStart.mockRejectedValueOnce(
      new BackendToolHttpError('HTTP 503', 503, errorBody),
    );

    await program.parseAsync([
      'node',
      'coral-cli',
      'discuss',
      'start',
      '--topic',
      'Bridge removal',
      '--agent',
      'name=alice,persona=Architect',
      '--agent',
      'name=bob,persona=Operator',
      '--output-format',
      'json',
    ]);

    expect(mockState.discussStart).toHaveBeenCalledWith({
      topic: 'Bridge removal',
      agents: [
        { name: 'alice', persona: 'Architect' },
        { name: 'bob', persona: 'Operator' },
      ],
    });
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({ error: true, code: 'backend_recovering', message: 'recovering — retry after 500ms' });
    expect(process.exitCode).toBe(75);
  });

  it('routes discuss participate bid payloads to discussBid', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.discussBid.mockResolvedValueOnce({
      agent_name: 'alice',
      score: 72,
      thought: 'Fits the current plan.',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'discuss',
      'participate',
      '--session',
      'session-1',
      '--agent-name',
      'alice',
      '--score',
      '72',
      '--thought',
      'Fits the current plan.',
      '--output-format',
      'json',
    ]);

    expect(mockState.discussBid).toHaveBeenCalledWith({
      session: 'session-1',
      agent_name: 'alice',
      score: 72,
      thought: 'Fits the current plan.',
    });
    expect(mockState.discussSpeech).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.trim())).toEqual({
      agent_name: 'alice',
      score: 72,
      thought: 'Fits the current plan.',
    });
  });

  it('routes discuss participate speech payloads to discussSpeech', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.discussSpeech.mockResolvedValueOnce({
      agent_name: 'alice',
      content: 'I support the change.',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'discuss',
      'participate',
      '--session',
      'session-1',
      '--agent-name',
      'alice',
      '--content',
      'I support the change.',
      '--output-format',
      'json',
    ]);

    expect(mockState.discussSpeech).toHaveBeenCalledWith({
      session: 'session-1',
      agent_name: 'alice',
      content: 'I support the change.',
    });
    expect(mockState.discussBid).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.trim())).toEqual({
      agent_name: 'alice',
      content: 'I support the change.',
    });
  });

  it('routes discuss watch through discussWatch', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.discussWatch.mockResolvedValueOnce({
      events: [],
      cursor: 4,
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'discuss',
      'watch',
      '--session',
      'session-1',
      '--cursor',
      '4',
      '--output-format',
      'json',
    ]);

    expect(mockState.discussWatch).toHaveBeenCalledWith('session-1', 4);
    expect(JSON.parse(stdout.trim())).toEqual({
      events: [],
      cursor: 4,
    });
  });

  it('routes discuss abort through discussAbort', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.discussAbort.mockResolvedValueOnce({
      ok: true,
      session: 'session-1',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'discuss',
      'abort',
      '--session',
      'session-1',
      '--output-format',
      'json',
    ]);

    expect(mockState.discussAbort).toHaveBeenCalledWith('session-1');
    expect(JSON.parse(stdout.trim())).toEqual({
      ok: true,
      session: 'session-1',
    });
  });

  it('routes bare kb search without top_k so backend defaults apply', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbSearch.mockResolvedValueOnce({
      results: [
        {
          note: 'cli-kb-tooling',
          kind: 'note',
          title: 'KB CLI Tooling',
          matchedBy: ['filename', 'content'],
          snippet: 'Use the read surface.',
        },
      ],
      mode: 'text',
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'search', 'accel']);

    expect(mockState.kbSearch).toHaveBeenCalledWith({ query: 'accel' });
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].note).toBe('cli-kb-tooling');
    expect(stderr).toBe('');
  });

  it('treats KB backend_recovering results as command errors without relying on thrown HTTP errors', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const errorBody = {
      code: 'backend_recovering',
      message: 'recovering — retry after 500ms',
    };

    const { BackendToolHttpError } = await import('../../client/http-client.js');
    mockState.kbSearch.mockRejectedValueOnce(
      new BackendToolHttpError('HTTP 503', 503, errorBody),
    );

    await program.parseAsync(['node', 'coral-cli', 'kb', 'search', 'accel', '--output-format', 'json']);

    expect(mockState.kbSearch).toHaveBeenCalledWith({ query: 'accel' });
    expect(stdout).toBe('');
    expect(JSON.parse(stderr.trim())).toEqual({ error: true, code: 'backend_recovering', message: 'recovering — retry after 500ms' });
    expect(process.exitCode).toBe(75);
  });

  it('routes kb search with --top-k and preserves raw json output', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbSearch.mockResolvedValueOnce({
      results: [],
      mode: 'text',
      warning: 'Run kb_reindex to build the search index.',
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'search', 'accel', '--top-k', '5', '--output-format', 'json']);

    expect(mockState.kbSearch).toHaveBeenCalledWith({ query: 'accel', top_k: 5 });
    expect(JSON.parse(stdout.trim())).toEqual({
      results: [],
      mode: 'text',
      warning: 'Run kb_reindex to build the search index.',
    });
  });

  it('formats hybrid kb search output with an indicator and rewritten warning text in text mode', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbSearch.mockResolvedValueOnce({
      results: [
        {
          note: 'hybrid-note',
          kind: 'note',
          title: 'Hybrid Note',
          matchedBy: [],
        },
      ],
      mode: 'hybrid',
      warning: 'Run kb_reindex again to refresh it.',
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'search', 'semantic']);

    const parsed = JSON.parse(stdout);
    expect(parsed.mode).toBe('hybrid');
    expect(parsed.indicator).toBe('[hybrid]');
    expect(parsed.warning).toContain(' kb reindex');
    expect(parsed.warning).not.toContain('kb_reindex');
    expect(parsed.results[0].matched).toEqual([]);
  });

  it('routes bare kb principles as an empty payload', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbPrinciples.mockResolvedValueOnce({
      principles: ['contract-first-design'],
      total: 1,
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'principles']);

    expect(mockState.kbPrinciples).toHaveBeenCalledWith({});
    expect(stdout).toBe('contract-first-design\nTotal: 1\n');
  });

  it('routes kb principles query and top-k flags', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbPrinciples.mockResolvedValueOnce({
      principles: [],
      total: 0,
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'principles', '--query', 'contract', '--top-k', '7']);

    expect(mockState.kbPrinciples).toHaveBeenCalledWith({ query: 'contract', top_k: 7 });
  });

  it('routes verbose kb principles and formats structured rows', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbPrinciples.mockResolvedValueOnce({
      principles: [
        {
          name: 'contract-first-design',
          statement: 'State contracts first.',
          notes: ['a-note', 'b-note'],
        },
      ],
      total: 2,
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'principles', '--verbose']);

    expect(mockState.kbPrinciples).toHaveBeenCalledWith({ verbose: true });
    expect(stdout).toBe('contract-first-design (a-note, b-note): State contracts first.\nTotal: 2\n');
  });

  it('routes kb memo write through kb_memo', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbMemo.mockResolvedValueOnce({
      filename: '20260327-184939-kb-routing.md',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'kb',
      'memo',
      'write',
      '--topic',
      'kb-routing',
      '--content',
      'Memo body',
      '--owner',
      'test-owner',
    ]);

    expect(mockState.kbMemo).toHaveBeenCalledWith({ topic: 'kb-routing', content: 'Memo body', owner: 'test-owner' });
    expect(stdout).toBe('Memo: 20260327-184939-kb-routing.md\n');
  });

  it('routes kb memo list through kb_memo_list', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbMemoList.mockResolvedValueOnce({
      memos: [{ filename: 'a.md', summary: 'summary', createdAt: '2026-03-27T00:00:00.000Z' }],
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'memo', 'list', '--output-format', 'json']);

    expect(mockState.kbMemoList).toHaveBeenCalledWith({});
    expect(JSON.parse(stdout.trim())).toEqual({
      memos: [{ filename: 'a.md', summary: 'summary', createdAt: '2026-03-27T00:00:00.000Z' }],
    });
  });

  it('routes kb memo delete through kb_memo_delete', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbMemoDelete.mockResolvedValueOnce({
      deleted: ['a.md'],
      count: 1,
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'memo', 'delete', '2026*', '--output-format', 'json']);

    expect(mockState.kbMemoDelete).toHaveBeenCalledWith({ pattern: '2026*' });
    expect(JSON.parse(stdout.trim())).toEqual({
      deleted: ['a.md'],
      count: 1,
    });
  });

  it('routes kb memo purge through kb_memo_purge', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbMemoPurge.mockResolvedValueOnce({
      deleted: 3,
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'memo', 'purge', '--output-format', 'json']);

    expect(mockState.kbMemoPurge).toHaveBeenCalledWith({});
    expect(JSON.parse(stdout.trim())).toEqual({ deleted: 3 });
  });

  it('routes kb read to kb_read and returns JSON', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbRead.mockResolvedValueOnce({
      kind: 'note',
      note: 'coral-kb-read',
      title: 'Read Test',
      content: '## Rule\nContent.',
      tags: ['coral'],
      principles: ['contract-first-design'],
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'read', 'coral-kb-read']);

    expect(mockState.kbRead).toHaveBeenCalledWith({ note: 'coral-kb-read' });
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.note).toBe('coral-kb-read');
    expect(parsed.title).toBe('Read Test');
  });

  it('routes kb promote flags into kb_promote arguments', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const tmpFile = join(tmpdir(), 'test-kb-content.md');

    mockState.kbPromote.mockResolvedValueOnce({
      path: '/tmp/kb/notes/cli-kb-tooling.md',
    });

    writeFileSync(tmpFile, 'Details', 'utf8');

    try {
      await program.parseAsync([
        'node',
        'coral-cli',
        'kb',
        'promote',
        '--memo',
        'memo/123.md',
        '--title',
        'KB CLI',
        '--content-file',
        tmpFile,
        '--domain',
        'cli',
        '--topic',
        'kb-tooling',
      ]);

      expect(mockState.kbPromote).toHaveBeenCalledWith({
        memo: 'memo/123.md',
        title: 'KB CLI',
        content: 'Details',
        domain: 'cli',
        topic: 'kb-tooling',
      });
      expect(stdout).toBe('Created: /tmp/kb/notes/cli-kb-tooling.md\n');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('routes kb update and only sends provided fields', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const tmpFile = join(tmpdir(), 'test-kb-update-content.md');

    mockState.kbUpdate.mockResolvedValueOnce({
      path: '/tmp/kb/notes/cli-kb-tooling.md',
    });

    writeFileSync(tmpFile, 'Updated', 'utf8');

    try {
      await program.parseAsync(['node', 'coral-cli', 'kb', 'update', 'cli-kb-tooling', '--content-file', tmpFile]);

      expect(mockState.kbUpdate).toHaveBeenCalledWith({
        note: 'cli-kb-tooling',
        content: 'Updated',
      });
      expect(stdout).toBe('Updated: /tmp/kb/notes/cli-kb-tooling.md\n');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('routes kb delete to the delete wrapper', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbDelete.mockResolvedValueOnce({
      deleted: '/tmp/kb/notes/cli-kb-tooling.md',
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'delete', 'cli-kb-tooling']);

    expect(mockState.kbDelete).toHaveBeenCalledWith({ note: 'cli-kb-tooling' });
    expect(stdout).toBe('Deleted: /tmp/kb/notes/cli-kb-tooling.md\n');
  });

  it('routes kb reindex and rewrites warning text using the active CLI invocation prefix', async () => {
    process.argv = ['node', '/tmp/path with spaces/coral-cli.cjs'];
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbReindex.mockResolvedValueOnce({
      notes: 4,
      sources: 0,
      communities: 0,
      principles: 2,
      tags: 3,
      duration_ms: 25,
      mode: 'text',
      warning: 'Run kb_reindex again to refresh it.',
    });

    await program.parseAsync(['node', 'coral-cli', 'kb', 'reindex']);

    expect(mockState.kbReindex).toHaveBeenCalledWith({});
    expect(stdout).toContain('Reindexed:');
    expect(stdout).toContain('node "/tmp/path with spaces/coral-cli.cjs" kb reindex');
  });
});
