import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { _resetProvidersForTests } from '../../providers/registry.js';
import { _resetProviderBootstrapForTests, registerBuiltInProviders } from '../../providers/bootstrap.js';
import { join } from 'node:path';
import { createSessionDir, readSessionStatus, writeSessionResult } from '../../runner/progress.js';
import { jsonResult, type McpResult } from '../../shared/mcp-utils.js';
import { handleWorkflow } from '../handler.js';
import type { SessionManager } from '../../runner/session-manager.js';
import type { SessionProvider } from '../../runner/types.js';

const dirsToClean = new Set<string>();

afterEach(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirsToClean.clear();
});

function parseLaunch(result: McpResult): { session: string; session_dir: string; status: string } {
  return JSON.parse(result.content[0].text) as { session: string; session_dir: string; status: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSessionManager(): SessionManager {
  return { register: vi.fn() } as unknown as SessionManager;
}

async function waitForTerminalStatus(sessionDir: string, timeoutMs = 4_000): Promise<{ status: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readSessionStatus(sessionDir);
    if (status.status !== 'running') return { status: status.status, error: status.error };
    await sleep(20);
  }
  throw new Error(`Session did not complete in time: ${sessionDir}`);
}

describe('workflow handler', () => {
  it('launches workflow jobs and returns running session info', async () => {
    const mgr = makeSessionManager();

    const toolCallFn = async (
      provider: SessionProvider,
      args: Record<string, unknown>,
    ): Promise<McpResult> => {
      const label = String(args.op);
      const launch = createSessionDir(label, provider);
      dirsToClean.add(launch.dir);
      writeSessionResult(launch.dir, `output:${label}`, { session_name: label });
      return jsonResult({ session: launch.id, session_dir: launch.dir, status: 'running' });
    };

    const result = handleWorkflow(
      { expression: 'architect -> resolver', prompt: 'hello' },
      toolCallFn,
      mgr,
    );
    const launch = parseLaunch(result);
    dirsToClean.add(launch.session_dir);

    expect(result.isError).toBe(false);
    expect(launch.status).toBe('running');

    const terminal = await waitForTerminalStatus(launch.session_dir);
    expect(terminal.status).toBe('completed');

    const finalOutput = readFileSync(join(launch.session_dir, 'result.md'), 'utf-8');
    expect(finalOutput).toBe('output:coral:resolver');
  });

  it('throws on schema validation failures', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: 'architect' },
        async () => jsonResult({}),
        mgr,
      )).toThrow();
  });

  it('throws on invalid expression syntax', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: '-> resolver', prompt: 'hello' },
        async () => jsonResult({}),
        mgr,
      )).toThrow('Expected step expression before "->"');
  });

  it('throws when args keys do not match expression atoms', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        {
          expression: 'architect',
          prompt: 'hello',
          args: {
            resolver: { model: 'o4-mini' },
          },
        },
        async () => jsonResult({}),
        mgr,
      )).toThrow('Unknown args keys: resolver');
  });

  it('throws for unsupported namespaces in v1', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: 'some-plugin:architect', prompt: 'hello' },
        async () => jsonResult({}),
        mgr,
      )).toThrow('unsupported namespace');
  });

  it('rejects unknown default provider before dispatching any atoms', () => {
    const mgr = makeSessionManager();
    const toolCallFn = vi.fn(async () => jsonResult({}));

    expect(() =>
      handleWorkflow(
        { expression: 'architect', prompt: 'hello', provider: 'unknown-provider' },
        toolCallFn,
        mgr,
      ),
    ).toThrow('Unknown provider "unknown-provider"');
    expect(toolCallFn).not.toHaveBeenCalled();
  });

  it('rejects unknown per-atom provider override before dispatch', () => {
    const mgr = makeSessionManager();
    const toolCallFn = vi.fn(async () => jsonResult({}));

    expect(() =>
      handleWorkflow(
        { expression: 'architect@unknown-provider', prompt: 'hello', provider: 'codex' },
        toolCallFn,
        mgr,
      ),
    ).toThrow('Unknown provider "unknown-provider"');
    expect(toolCallFn).not.toHaveBeenCalled();
  });

  it('writes step progress events through launchJob makeOnEvent wiring', async () => {
    const mgr = makeSessionManager();

    const toolCallFn = async (
      provider: SessionProvider,
      args: Record<string, unknown>,
    ): Promise<McpResult> => {
      const launch = createSessionDir(String(args.op), provider);
      dirsToClean.add(launch.dir);
      writeSessionResult(launch.dir, 'done', { session_name: String(args.op) });
      return jsonResult({ session: launch.id, session_dir: launch.dir, status: 'running' });
    };

    const result = handleWorkflow(
      { expression: 'architect', prompt: 'hello' },
      toolCallFn,
      mgr,
    );
    const launch = parseLaunch(result);
    dirsToClean.add(launch.session_dir);

    await waitForTerminalStatus(launch.session_dir);

    const progressPath = join(launch.session_dir, 'progress.jsonl');
    const lines = readFileSync(progressPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { message?: string });

    expect(lines.some((line) => line.message === 'step 1 started')).toBe(true);
    expect(lines.some((line) => line.message === 'step 1 completed')).toBe(true);
  });

  it('passes progressToken and notify through nested tool dispatch', async () => {
    const mgr = makeSessionManager();

    const notify = vi.fn(async () => {});
    const toolCallFn = vi.fn(async (
      provider: SessionProvider,
      args: Record<string, unknown>,
      _mgr: SessionManager,
      progressToken?: string | number,
      notifyFn?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
    ) => {
      const launch = createSessionDir(String(args.op), provider);
      dirsToClean.add(launch.dir);
      writeSessionResult(launch.dir, 'done', { session_name: String(args.op) });
      expect(progressToken).toBe('token-1');
      expect(notifyFn).toBe(notify);
      return jsonResult({ session: launch.id, session_dir: launch.dir, status: 'running' });
    });

    const result = handleWorkflow(
      { expression: 'architect', prompt: 'hello' },
      toolCallFn,
      mgr,
      'token-1',
      notify,
    );
    const launch = parseLaunch(result);
    dirsToClean.add(launch.session_dir);

    await waitForTerminalStatus(launch.session_dir);
    expect(toolCallFn).toHaveBeenCalled();
  });

  it('parses double-quoted workflow prompt literals', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: '"echo hi"', prompt: 'hello' },
        async () => jsonResult({}),
        mgr,
      )).not.toThrow();
  });

  it('normalizes defaults before validation', async () => {
    const mgr = makeSessionManager();
    const toolCallFn = vi.fn(async (
      provider: SessionProvider,
      args: Record<string, unknown>,
    ): Promise<McpResult> => {
      expect(provider).toBe('codex');
      expect(args.op).toBe('coral:architect');
      const launch = createSessionDir(String(args.op), provider);
      dirsToClean.add(launch.dir);
      writeSessionResult(launch.dir, 'done', { session_name: String(args.op) });
      return jsonResult({ session: launch.id, session_dir: launch.dir, status: 'running' });
    });

    const result = handleWorkflow(
      { expression: 'architect', prompt: 'hello', provider: 'codex' },
      toolCallFn,
      mgr,
    );
    const launch = parseLaunch(result);
    dirsToClean.add(launch.session_dir);
    await waitForTerminalStatus(launch.session_dir);

    expect(toolCallFn).toHaveBeenCalled();
  });

  it('rejects parallel step with same resolved provider', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: '(architect, architect@codex)', prompt: 'hello', provider: 'codex' },
        async () => jsonResult({}),
        mgr,
      ),
    ).toThrow('Duplicate atom');
  });

  it('allows parallel step with different resolved providers', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: '(architect, architect@claude)', prompt: 'hello', provider: 'codex' },
        async () => jsonResult({}),
        mgr,
      ),
    ).not.toThrow();
  });

  it('skips duplicate check for prompt literals in parallel group', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: "('summarize', architect)", prompt: 'hello', provider: 'codex' },
        async () => jsonResult({}),
        mgr,
      ),
    ).not.toThrow();
  });

  it('accepts args key matching atom that appears in multiple sequential steps', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        {
          expression: 'architect -> resolver -> architect',
          prompt: 'hello',
          args: { architect: { model: 'o4-mini' }, resolver: {} },
        },
        async () => jsonResult({}),
        mgr,
      ),
    ).not.toThrow();
  });

  it('accepts explicit coral namespace — validateNamespaces does not reject it', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: 'coral:architect', prompt: 'hello' },
        async () => jsonResult({}),
        mgr,
      ),
    ).not.toThrow();
  });

  it('throws on whitespace-only expression', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: '   ', prompt: 'hello' },
        async () => jsonResult({}),
        mgr,
      ),
    ).toThrow();
  });
});

describe('workflow handler — singular vs plural unknown provider error', () => {
  beforeEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
    registerBuiltInProviders();
  });
  afterEach(() => {
    _resetProvidersForTests();
    _resetProviderBootstrapForTests();
  });

  it('two distinct unknown providers produce the plural "Unknown providers:" message', () => {
    const mgr = makeSessionManager();
    expect(() =>
      handleWorkflow(
        { expression: 'architect@bad2', prompt: 'hi', provider: 'bad1' },
        async () => jsonResult({}),
        mgr,
      ),
    ).toThrow(/Unknown providers:/i);
  });

});
