import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MainMod from '../main.js';

const mockState = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  listSessions: vi.fn(),
  workflow: vi.fn(),
  abortJobs: vi.fn(),
  launchAndFollow: vi.fn(),
  ensureBackend: vi.fn(),
  getBackendStatusFull: vi.fn(),
  shutdownBackend: vi.fn(),
  streamWait: vi.fn(),
  discussSeed: vi.fn(),
  discussStart: vi.fn(),
  discussWatch: vi.fn(),
  discussParticipate: vi.fn(),
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
    listSessions = mockState.listSessions;
    workflow = mockState.workflow;
    abortJobs = mockState.abortJobs;
    discussSeed = mockState.discussSeed;
    discussStart = mockState.discussStart;
    discussWatch = mockState.discussWatch;
    discussParticipate = mockState.discussParticipate;
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
    mockState.listSessions.mockReset();
    mockState.workflow.mockReset();
    mockState.abortJobs.mockReset();
    mockState.launchAndFollow.mockReset();
    mockState.ensureBackend.mockReset();
    mockState.getBackendStatusFull.mockReset();
    mockState.shutdownBackend.mockReset();
    mockState.streamWait.mockReset();
    mockState.discussSeed.mockReset();
    mockState.discussStart.mockReset();
    mockState.discussWatch.mockReset();
    mockState.discussParticipate.mockReset();
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
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('exposes a reusable program factory', async () => {
    const { buildProgram } = await loadMainModule();

    const program = buildProgram();

    expect(program.name()).toBe('coral-cli');
    expect(program.commands.find((command) => command.name() === 'list')).toBeDefined();
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

    expect(mockState.sendMessage).toHaveBeenCalledWith('session-raw-text', missingInput, {});
  });

  it.each([
    ['debugger', 'coral:debugger'],
    ['coral:debugger', 'coral:debugger'],
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

    expect(mockState.createSession).toHaveBeenCalledWith('claude', 'hi', { agent: 'coral:debugger' });
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

  it('intercepts legacy provider list before input validation', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    await program.parseAsync(['node', 'coral-cli', 'codex', 'list']);

    expect(stderr).toContain('coral-cli list --provider codex');
    expect(stderr).not.toContain('input is required');
    expect(mockState.createSession).not.toHaveBeenCalled();
    expect(mockState.sendMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('lists sessions for a single provider via the top-level list command', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.listSessions.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: 'session-1',
          provider: 'codex',
          name: 'alpha',
          state: 'ready',
          model: 'gpt-5',
          cwd: '/tmp/project',
          createdAt: '2026-03-14T00:00:00.000Z',
          lastUsedAt: '2026-03-14T00:00:00.000Z',
          version: 1,
          provenanceState: 'authoritative',
        },
      ],
    });

    await program.parseAsync(['node', 'coral-cli', 'list', '--provider', 'codex', '-f', 'json']);

    expect(mockState.listSessions).toHaveBeenCalledWith();
    expect(JSON.parse(stdout.trim())).toEqual({
      sessions: [
        {
          sessionId: 'session-1',
          provider: 'codex',
          name: 'alpha',
          state: 'ready',
          model: 'gpt-5',
          cwd: '/tmp/project',
        },
      ],
    });
  });

  it('aggregates provider sessions at the top level and includes provider labels in text output', async () => {
    const { buildProgram } = await loadMainModule();
    const program = buildProgram();

    mockState.listSessions
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: 'session-1',
            provider: 'codex',
            name: 'alpha',
            state: 'ready',
            model: 'gpt-5',
            cwd: '/tmp/codex',
            createdAt: '2026-03-14T00:00:00.000Z',
            lastUsedAt: '2026-03-14T00:00:00.000Z',
            version: 1,
            provenanceState: 'authoritative',
          },
          {
            sessionId: 'session-2',
            provider: 'claude',
            name: 'beta',
            state: 'ready',
            model: 'sonnet',
            cwd: '/tmp/claude',
            createdAt: '2026-03-15T00:00:00.000Z',
            lastUsedAt: '2026-03-15T00:00:00.000Z',
            version: 1,
            provenanceState: 'authoritative',
          },
        ],
      });

    await program.parseAsync(['node', 'coral-cli', 'list']);

    expect(mockState.listSessions).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('PROVIDER');
    expect(stdout).toContain('codex');
    expect(stdout).toContain('claude');
    expect(stdout).toContain('session-1');
    expect(stdout).toContain('session-2');
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
        isTTY: process.stdout.isTTY === true,
        columns: process.stdout.columns ?? 80,
      });
      expect(process.exitCode).toBe(0);
    } finally {
      unlinkSync(promptFile);
      unlinkSync(contextFile);
    }
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
    expect(JSON.parse(stderr.trim())).toEqual({ error: true, statusCode: 503, body: errorBody });
    expect(process.exitCode).toBe(1);
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
    expect(JSON.parse(stderr.trim())).toEqual({ error: true, statusCode: 503, body: errorBody });
    expect(process.exitCode).toBe(1);
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
