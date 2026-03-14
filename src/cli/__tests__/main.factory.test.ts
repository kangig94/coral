import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  providerExec: vi.fn(),
  providerFork: vi.fn(),
  providerCoralDispatch: vi.fn(),
  providerList: vi.fn(),
  workflow: vi.fn(),
  abortJobs: vi.fn(),
  launchAndFollow: vi.fn(),
  ensureBackend: vi.fn(),
  getBackendStatusFull: vi.fn(),
  shutdownBackend: vi.fn(),
  streamWait: vi.fn(),
}));

vi.mock('../../client/http-client.js', () => {
  class BackendToolHttpError extends Error {
    statusCode: number;
    body: unknown;

    constructor(statusCode: number, body: unknown) {
      super(`HTTP ${statusCode}`);
      this.statusCode = statusCode;
      this.body = body;
    }
  }

  class BackendClient {
    providerExec = mockState.providerExec;
    providerFork = mockState.providerFork;
    providerCoralDispatch = mockState.providerCoralDispatch;
    providerList = mockState.providerList;
    workflow = mockState.workflow;
    abortJobs = mockState.abortJobs;
    discussSeed = vi.fn();
    discussStart = vi.fn();
    discussWatch = vi.fn();
    discussParticipate = vi.fn();
    discussAbort = vi.fn();

    constructor(_options: unknown) {}
  }

  return { BackendClient, BackendToolHttpError };
});

vi.mock('../../client/backend-lifecycle.js', () => ({
  ensureBackend: mockState.ensureBackend,
}));

vi.mock('../../bridge/backend-client.js', () => ({
  getBackendStatusFull: mockState.getBackendStatusFull,
  shutdownBackend: mockState.shutdownBackend,
  streamWait: mockState.streamWait,
}));

vi.mock('../follow.js', () => ({
  launchAndFollow: mockState.launchAndFollow,
}));

type MainModule = typeof import('../main.js');

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function loadMainModule(): Promise<MainModule> {
  vi.resetModules();
  return import('../main.js');
}

describe('cli main factory', () => {
  let stdout = '';
  let stderr = '';

  beforeEach(() => {
    stdout = '';
    stderr = '';
    process.exitCode = undefined;

    mockState.providerExec.mockReset();
    mockState.providerFork.mockReset();
    mockState.providerCoralDispatch.mockReset();
    mockState.providerList.mockReset();
    mockState.workflow.mockReset();
    mockState.abortJobs.mockReset();
    mockState.launchAndFollow.mockReset();
    mockState.ensureBackend.mockReset();
    mockState.getBackendStatusFull.mockReset();
    mockState.shutdownBackend.mockReset();
    mockState.streamWait.mockReset();

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
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('exposes a reusable program factory and exports normalizeProviderArgv', async () => {
    const { buildProgram, normalizeProviderArgv } = await loadMainModule();

    const program = buildProgram();

    expect(program.name()).toBe('coral-cli');
    expect(normalizeProviderArgv(['node', 'coral-cli', 'codex', 'coral:architect', '--prompt', 'hi']))
      .toEqual(['node', 'coral-cli', 'codex', 'coral', 'architect', '--prompt', 'hi']);
  });

  it('adds --detach to exec, fork, coral, and workflow command help', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();
    const codex = program.commands.find((command) => command.name() === 'codex');
    const workflow = program.commands.find((command) => command.name() === 'workflow');

    expect(codex?.commands.find((command) => command.name() === 'exec')?.helpInformation()).toContain('--detach');
    expect(codex?.commands.find((command) => command.name() === 'fork')?.helpInformation()).toContain('--detach');
    expect(codex?.commands.find((command) => command.name() === 'coral')?.helpInformation()).toContain('--detach');
    expect(workflow?.helpInformation()).toContain('--detach');
  });

  it('keeps detach launches on the one-shot path and honors global json output after the subcommand', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.providerExec.mockResolvedValueOnce({
      status: 'running',
      job: 'job-1',
      session: 'session-1',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'codex',
      'exec',
      '--prompt',
      'hi',
      '--detach',
      '--output-format',
      'json',
    ]);

    expect(JSON.parse(stdout.trim())).toEqual({
      status: 'running',
      job: 'job-1',
      session: 'session-1',
    });
    expect(stderr).toBe('');
    expect(mockState.launchAndFollow).not.toHaveBeenCalled();
  });

  it('routes default exec launches into launchAndFollow', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.providerExec.mockResolvedValueOnce({
      status: 'running',
      job: 'job-1',
      session: 'session-1',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(7);

    await program.parseAsync([
      'node',
      'coral-cli',
      'codex',
      'exec',
      '--prompt',
      'hi',
      '--output-format',
      'json',
    ]);

    expect(mockState.launchAndFollow).toHaveBeenCalledWith({
      launchResult: {
        status: 'running',
        job: 'job-1',
        session: 'session-1',
      },
      abortJob: expect.any(Function),
      pluginRoot: expect.any(String),
      projectRoot: process.cwd(),
      outputFormat: 'json',
      isTTY: process.stdout.isTTY === true,
      columns: process.stdout.columns ?? 80,
    });
    expect(process.exitCode).toBe(7);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('formats rejected launch decisions on stderr and does not follow them', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.providerExec.mockResolvedValueOnce({
      status: 'rejected',
      phase: 'preflight',
      code: 'bad_request',
      message: 'Missing prompt',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'codex',
      'exec',
      '--prompt',
      'hi',
    ]);

    expect(stdout).toBe('');
    expect(stderr).toBe('Rejected [bad_request]: Missing prompt\n');
    expect(process.exitCode).toBe(1);
    expect(mockState.launchAndFollow).not.toHaveBeenCalled();
  });

  it('routes workflow launches into launchAndFollow by default', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.workflow.mockResolvedValueOnce({
      status: 'queued',
      job: 'job-2',
      session: 'session-2',
    });
    mockState.launchAndFollow.mockResolvedValueOnce(0);

    await program.parseAsync([
      'node',
      'coral-cli',
      'workflow',
      '--expression',
      '(architect)',
      '--init-prompt',
      'hi',
      '--output-format',
      'json',
    ]);

    expect(mockState.launchAndFollow).toHaveBeenCalledWith({
      launchResult: {
        status: 'queued',
        job: 'job-2',
        session: 'session-2',
      },
      abortJob: expect.any(Function),
      pluginRoot: expect.any(String),
      projectRoot: process.cwd(),
      outputFormat: 'json',
      isTTY: process.stdout.isTTY === true,
      columns: process.stdout.columns ?? 80,
    });
    expect(process.exitCode).toBe(0);
  });
});
