import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexExecOptions } from '../codex-executor.js';
import type { ProviderCliResult } from '../../runner-port.js';
import type * as CodexExecutorMod from '../codex-executor.js';

type ExecutorModule = typeof CodexExecutorMod;

let executeOneShot: ExecutorModule['executeOneShot'];
let executeResume: ExecutorModule['executeResume'];
let executeFork: ExecutorModule['executeFork'];
let mockRunCli: ReturnType<typeof vi.fn>;

async function loadExecutor(pluginRoot?: string): Promise<ExecutorModule> {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (pluginRoot !== undefined) {
    vi.stubGlobal('__PLUGIN_ROOT__', pluginRoot);
  }
  return import('../codex-executor.js');
}

const authenticatedCli = { available: true as const, version: '1.0.0', authState: 'authenticated' as const };

function cliResult(stdout: string, overrides: Partial<ProviderCliResult> = {}): ProviderCliResult {
  return {
    stdout,
    stderr: '',
    code: 0,
    aborted: false,
    ...overrides,
  };
}

function withAuthenticatedCli(
  overrides: Partial<Omit<CodexExecOptions, 'preChecked' | 'runCli'>> = {},
): CodexExecOptions {
  return {
    environment: {},
    runCli: mockRunCli as CodexExecOptions['runCli'],
    ...overrides,
    preChecked: authenticatedCli,
  };
}

function jsonl(...lines: string[]): string {
  return lines.join('\n');
}

function agentMessage(text = 'OK'): string {
  return `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"${text}"}}\n`;
}

const FULL_AUTO_FLAGS = [
  '--json',
  '--skip-git-repo-check',
  '--full-auto',
  '-c',
  'web_search=live',
  '-c',
  'sandbox_mode=workspace-write',
  '-c',
  'sandbox_workspace_write.network_access=true',
];

const BYPASS_FLAGS = [
  '--json',
  '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox',
  '-c',
  'web_search=live',
];

function expectedDefaultEffortFlag(): string {
  const codexEnv = process.env.CORAL_CODEX_EFFORT;
  if (codexEnv !== undefined) return codexEnv;
  const shared = process.env.CORAL_EFFORT;
  if (shared !== undefined) return shared === 'max' ? 'xhigh' : shared;
  return 'xhigh';
}

const DEFAULT_EFFORT_FLAGS = ['-c', `model_reasoning_effort=${expectedDefaultEffortFlag()}`];

beforeEach(async () => {
  mockRunCli = vi.fn().mockResolvedValue(cliResult(agentMessage()));
  ({ executeOneShot, executeResume, executeFork } = await loadExecutor());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('prependInjectMd', () => {
  it('prepends INJECT.md content to prompt', async () => {
    const pluginRoot = mkdtempSync(join('/tmp', 'coral-codex-plugin-'));
    try {
      writeFileSync(join(pluginRoot, 'INJECT.md'), '# Guidelines\nBe concise.');
      const customExecutor = await loadExecutor(pluginRoot);
      const runCli = vi.fn().mockResolvedValue(cliResult(agentMessage()));

      await customExecutor.executeOneShot('do something', {
        ...withAuthenticatedCli(),
        runCli,
      });

      expect(runCli).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '# Guidelines\nBe concise.\n\n---\n\ndo something',
        }),
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it('replaces {{CORAL_PROJECTS}} using workingDirectory before prepending', async () => {
    const pluginRoot = mkdtempSync(join('/tmp', 'coral-codex-plugin-'));
    try {
      writeFileSync(join(pluginRoot, 'INJECT.md'), 'Memo dir: {{CORAL_PROJECTS}}/memo');
      const customExecutor = await loadExecutor(pluginRoot);
      const runCli = vi.fn().mockResolvedValue(cliResult(agentMessage()));

      await customExecutor.executeOneShot('do something', {
        ...withAuthenticatedCli({ workingDirectory: '/tmp/project-root' }),
        runCli,
      });

      expect(runCli).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: `Memo dir: ${join(homedir(), '.coral', 'projects', 'local-project-root')}/memo\n\n---\n\ndo something`,
        }),
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it('replaces {{CORAL_CLI}} with the shell-quoted coral-cli bridge path before prepending', async () => {
    const pluginRoot = mkdtempSync(join('/tmp', 'coral codex plugin-'));
    try {
      writeFileSync(join(pluginRoot, 'INJECT.md'), 'KB: {{CORAL_CLI}} kb search "accel"');
      const customExecutor = await loadExecutor(pluginRoot);
      const runCli = vi.fn().mockResolvedValue(cliResult(agentMessage()));

      await customExecutor.executeOneShot('do something', {
        ...withAuthenticatedCli(),
        runCli,
      });

      expect(runCli).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: `KB: node "${join(pluginRoot, 'bridge', 'coral-cli.cjs')}" kb search "accel"\n\n---\n\ndo something`,
        }),
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it('returns prompt unchanged when INJECT.md is empty', async () => {
    const pluginRoot = mkdtempSync(join('/tmp', 'coral-codex-plugin-'));
    try {
      writeFileSync(join(pluginRoot, 'INJECT.md'), '');
      const customExecutor = await loadExecutor(pluginRoot);
      const runCli = vi.fn().mockResolvedValue(cliResult(agentMessage()));

      await customExecutor.executeOneShot('do something', {
        ...withAuthenticatedCli(),
        runCli,
      });

      expect(runCli).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'do something' }));
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });
});

describe('executeOneShot', () => {
  it('sends the expected runner request and parses the JSONL response', async () => {
    const output = jsonl(
      '{"type":"thread.started","thread_id":"t-123"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Hello"}}',
    );
    mockRunCli.mockResolvedValue(cliResult(output));

    const result = await executeOneShot(
      'test prompt',
      withAuthenticatedCli({ model: 'o4-mini', workingDirectory: '/tmp' }),
    );

    expect(mockRunCli).toHaveBeenCalledWith({
      command: 'codex',
      args: ['exec', '-m', 'o4-mini', ...FULL_AUTO_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      prompt: 'test prompt',
      cwd: '/tmp',
      extraEnv: {},
      onEvent: undefined,
    });
    expect(result).toMatchObject({
      response: 'Hello',
      sessionId: 't-123',
      model: 'o4-mini',
      exitCode: 0,
      errors: [],
      warnings: [],
      aborted: false,
    });
  });

  it('throws when preChecked is unauthenticated', async () => {
    await expect(
      executeOneShot('test', {
        environment: {},
        runCli: mockRunCli as CodexExecOptions['runCli'],
        preChecked: {
          available: true,
          version: '1.0.0',
          authState: 'unauthenticated',
          authError:
            'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
        },
      }),
    ).rejects.toThrow('Codex CLI is not authenticated');

    expect(mockRunCli).not.toHaveBeenCalled();
  });

  it('throws on non-zero exit with no stdout', async () => {
    mockRunCli.mockResolvedValue(cliResult('', { code: 1 }));

    await expect(executeOneShot('test', withAuthenticatedCli())).rejects.toThrow('Codex exited with code 1');
  });

  it('returns exitCode when non-zero with stdout', async () => {
    const output = jsonl(
      '{"type":"error","message":"Rate limit"}',
      '{"type":"turn.failed","error":{"message":"Rate limit"}}',
    );
    mockRunCli.mockResolvedValue(cliResult(output, { code: 1 }));

    const result = await executeOneShot('test', withAuthenticatedCli());

    expect(result.exitCode).toBe(1);
    expect(result.response).toBe('');
    expect(result.errors).toEqual(['Rate limit']);
  });

  it('returns an aborted result without throwing when the runner reports abort', async () => {
    mockRunCli.mockResolvedValue(cliResult('', { code: 1, aborted: true }));

    await expect(executeOneShot('test', withAuthenticatedCli())).resolves.toMatchObject({
      aborted: true,
      response: '',
      sessionId: null,
    });
  });

  it('throws when Codex exits successfully but produces no meaningful output', async () => {
    const output = jsonl(
      '{"type":"thread.started","thread_id":"t-empty"}',
      '{"type":"item.completed","item":{"id":"w1","type":"error","message":"Deprecated API usage"}}',
    );
    mockRunCli.mockResolvedValue(cliResult(output));

    await expect(executeOneShot('test', withAuthenticatedCli())).rejects.toThrow(
      'Codex produced no meaningful output (no assistant content, no errors)',
    );
  });

  it('maps max effort to the Codex-native xhigh flag', async () => {
    await executeOneShot('test', withAuthenticatedCli({ model: 'o4-mini', workingDirectory: '/tmp', effort: 'max' }));

    expect(mockRunCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['exec', '-m', 'o4-mini', ...FULL_AUTO_FLAGS, '-c', 'model_reasoning_effort=xhigh'],
      }),
    );
  });

  it('uses the default model when none is provided', async () => {
    const result = await executeOneShot('test', withAuthenticatedCli());

    expect(result.model).toBe('gpt-5.4');
  });

  it('uses bypass flags when bypassSandbox is true', async () => {
    await executeOneShot(
      'test',
      withAuthenticatedCli({ model: 'o4-mini', workingDirectory: '/tmp', bypassSandbox: true }),
    );

    expect(mockRunCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['exec', '-m', 'o4-mini', ...BYPASS_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      }),
    );
  });

  it('forwards onEvent to the runner port', async () => {
    const onEvent = vi.fn();

    await executeOneShot('test', withAuthenticatedCli({ onEvent }));

    expect(mockRunCli).toHaveBeenCalledWith(expect.objectContaining({ onEvent }));
  });
});

describe('executeResume', () => {
  it('passes the expected resume request to the runner', async () => {
    const output = jsonl(
      '{"type":"thread.started","thread_id":"thread-abc"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Resumed"}}',
    );
    mockRunCli.mockResolvedValue(cliResult(output));

    const result = await executeResume('thread-abc', 'continue', withAuthenticatedCli({ model: 'gpt-4.1' }));

    expect(mockRunCli).toHaveBeenCalledWith({
      command: 'codex',
      args: ['exec', 'resume', 'thread-abc', '-m', 'gpt-4.1', ...FULL_AUTO_FLAGS, ...DEFAULT_EFFORT_FLAGS],
      prompt: 'continue',
      cwd: undefined,
      extraEnv: {},
      onEvent: undefined,
    });
    expect(result.response).toBe('Resumed');
    expect(result.sessionId).toBe('thread-abc');
  });

  it('throws verbatim authError before calling the runner', async () => {
    await expect(
      executeResume('thread-abc', 'continue', {
        environment: {},
        bypassSandbox: false,
        runCli: mockRunCli as CodexExecOptions['runCli'],
        preChecked: {
          available: true,
          version: '1.0.0',
          authState: 'unauthenticated',
          authError: 'Custom auth error for resume test',
        },
      }),
    ).rejects.toThrow('Custom auth error for resume test');

    expect(mockRunCli).not.toHaveBeenCalled();
  });
});

describe('executeFork', () => {
  it('delegates to resume using the provided prompt', async () => {
    const output = jsonl(
      '{"type":"thread.started","thread_id":"t-fork"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Forked"}}',
    );
    mockRunCli.mockResolvedValue(cliResult(output));

    const result = await executeFork('thread-orig', 'Continue from where we left off.', withAuthenticatedCli());

    expect(mockRunCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['exec', 'resume', 'thread-orig']),
        prompt: 'Continue from where we left off.',
      }),
    );
    expect(result.response).toBe('Forked');
    expect(result.sessionId).toBe('t-fork');
  });
});

describe('ensureMultiAgent', () => {
  const originalHome = process.env.HOME;
  const homesToClean = new Set<string>();

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const home of homesToClean) {
      rmSync(home, { recursive: true, force: true });
    }
    homesToClean.clear();
  });

  it('writes multi_agent = true when config is missing', async () => {
    const home = mkdtempSync(join('/tmp', 'coral-executor-home-'));
    homesToClean.add(home);
    process.env.HOME = home;

    await executeOneShot('test', withAuthenticatedCli());

    const configPath = join(home, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe('[features]\nmulti_agent = true\n');
  });

  it("repeated calls don't rewrite after first success", async () => {
    const home = mkdtempSync(join('/tmp', 'coral-executor-home-'));
    homesToClean.add(home);
    process.env.HOME = home;

    await executeOneShot('first', withAuthenticatedCli());

    const configPath = join(home, '.codex', 'config.toml');
    const firstMtime = statSync(configPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    await executeOneShot('second', withAuthenticatedCli());

    const secondMtime = statSync(configPath).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it('existing config with multi_agent = true remains unchanged', async () => {
    const home = mkdtempSync(join('/tmp', 'coral-executor-home-'));
    homesToClean.add(home);
    process.env.HOME = home;
    mkdirSync(join(home, '.codex'), { recursive: true });
    const configPath = join(home, '.codex', 'config.toml');
    const existing = '[features]\nmulti_agent = true\nother_flag = true\n';
    writeFileSync(configPath, existing);

    await executeOneShot('test', withAuthenticatedCli());

    expect(readFileSync(configPath, 'utf8')).toBe(existing);
  });
});
