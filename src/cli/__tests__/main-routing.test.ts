import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  kbSearch: vi.fn(),
  kbPrinciples: vi.fn(),
  kbPromote: vi.fn(),
  kbUpdate: vi.fn(),
  kbDelete: vi.fn(),
  kbReindex: vi.fn(),
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
    kbSearch = mockState.kbSearch;
    kbPrinciples = mockState.kbPrinciples;
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

describe('cli main routing', () => {
  let stdout = '';
  let stderr = '';
  let originalArgv: string[];

  beforeEach(() => {
    stdout = '';
    stderr = '';
    originalArgv = [...process.argv];
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
    mockState.kbSearch.mockReset();
    mockState.kbPrinciples.mockReset();
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

  it('routes bare kb search without top_k so backend defaults apply', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbSearch.mockResolvedValueOnce({
      results: [],
      mode: 'basic',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'kb',
      'search',
      'accel',
    ]);

    expect(mockState.kbSearch).toHaveBeenCalledWith({ query: 'accel' });
    expect(stdout).toBe('No results\nMode: basic\n');
    expect(stderr).toBe('');
  });

  it('routes kb search with --top-k and preserves raw json output', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbSearch.mockResolvedValueOnce({
      results: [],
      mode: 'basic',
      warning: 'Run kb_reindex to build the search index.',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'kb',
      'search',
      'accel',
      '--top-k',
      '5',
      '--output-format',
      'json',
    ]);

    expect(mockState.kbSearch).toHaveBeenCalledWith({ query: 'accel', top_k: 5 });
    expect(JSON.parse(stdout.trim())).toEqual({
      results: [],
      mode: 'basic',
      warning: 'Run kb_reindex to build the search index.',
    });
  });

  it('routes bare kb principles as an empty payload', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbPrinciples.mockResolvedValueOnce({
      principles: ['contract-first-design'],
      total: 1,
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'kb',
      'principles',
    ]);

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

    await program.parseAsync([
      'node',
      'coral-cli',
      'kb',
      'principles',
      '--query',
      'contract',
      '--top-k',
      '7',
    ]);

    expect(mockState.kbPrinciples).toHaveBeenCalledWith({ query: 'contract', top_k: 7 });
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
        '--tag',
        'cli',
        '--tag',
        'kb',
        '--principle',
        'contract-first-design',
        '--domain',
        'cli',
        '--topic',
        'kb-tooling',
      ]);

      expect(mockState.kbPromote).toHaveBeenCalledWith({
        memo: 'memo/123.md',
        title: 'KB CLI',
        content: 'Details',
        tags: ['cli', 'kb'],
        principles: ['contract-first-design'],
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
      await program.parseAsync([
        'node',
        'coral-cli',
        'kb',
        'update',
        'cli-kb-tooling',
        '--content-file',
        tmpFile,
        '--tag',
        'cli',
        '--principle',
        'verify-at-boundaries',
      ]);

      expect(mockState.kbUpdate).toHaveBeenCalledWith({
        note: 'cli-kb-tooling',
        content: 'Updated',
        tags: ['cli'],
        principles: ['verify-at-boundaries'],
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

    await program.parseAsync([
      'node',
      'coral-cli',
      'kb',
      'delete',
      'cli-kb-tooling',
    ]);

    expect(mockState.kbDelete).toHaveBeenCalledWith({ note: 'cli-kb-tooling' });
    expect(stdout).toBe('Deleted: /tmp/kb/notes/cli-kb-tooling.md\n');
  });

  it('routes kb reindex and rewrites warning text using the active CLI invocation prefix', async () => {
    process.argv = ['node', '/tmp/path with spaces/coral-cli.cjs'];
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.kbReindex.mockResolvedValueOnce({
      notes: 4,
      principles: 2,
      tags: 3,
      duration_ms: 25,
      mode: 'basic',
      warning: 'Run kb_reindex again to refresh it.',
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'kb',
      'reindex',
    ]);

    expect(mockState.kbReindex).toHaveBeenCalledWith({});
    expect(stdout).toContain('NOTES');
    expect(stdout).toContain('node "/tmp/path with spaces/coral-cli.cjs" kb reindex');
  });
});
