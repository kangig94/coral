/**
 * Codex CLI execution logic.
 *
 * Spawns `codex exec` processes and collects output.
 * IMPORTANT: Never use console.log — this runs inside a stdio MCP server.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { CodexExecResult } from '../types.js';
import { parseCodexJsonl } from './output-parser.js';
import { detectCodexCli } from './cli-detection.js';

const DEFAULT_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const TIMEOUT_MS = parseInt(process.env.CORAL_CODEX_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT;
const DEFAULT_MODEL = process.env.CORAL_CODEX_MODEL ?? 'gpt-5.3-codex';
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const SIGKILL_DELAY = 5_000; // 5 seconds after SIGTERM
const MAX_CONCURRENT = parseInt(process.env.CORAL_MAX_CONCURRENT ?? '', 10) || 5;
const STAGGER_MS = parseInt(process.env.CORAL_STAGGER_MS ?? '', 10) || 3_000;

/**
 * Promise-based semaphore for limiting concurrent Codex processes.
 */
class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.running <= 0) {
      throw new Error('Semaphore: release called without matching acquire');
    }
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Current number of running tasks. Exposed for testing. */
  get active(): number {
    return this.running;
  }

  /** Current number of waiting tasks. Exposed for testing. */
  get pending(): number {
    return this.queue.length;
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT);
let lastStartTime = 0;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stagger mutex serializes the read-sleep-update sequence.
 * Without this, multiple coroutines that acquire the concurrency semaphore
 * simultaneously could all read the same lastStartTime and start together,
 * defeating the burst prevention purpose.
 */
const staggerMutex = new Semaphore(1);

/**
 * Enforce minimum delay between process starts to prevent burst.
 * Serialized via staggerMutex to prevent concurrent coroutines from
 * reading the same lastStartTime and sleeping in parallel.
 */
async function enforceStagger(): Promise<void> {
  await staggerMutex.acquire();
  try {
    const gap = Date.now() - lastStartTime;
    if (gap < STAGGER_MS) {
      await sleep(STAGGER_MS - gap);
    }
    lastStartTime = Date.now();
  } finally {
    staggerMutex.release();
  }
}

/** Track active child processes for graceful shutdown. */
const activeChildren = new Set<ChildProcess>();

function getModel(model?: string): string {
  return model?.trim() || DEFAULT_MODEL;
}

/**
 * Append data to a buffer string, enforcing a size limit.
 */
function appendBuffer(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length > MAX_BUFFER) {
    return combined.slice(0, MAX_BUFFER) + '\n[output truncated at 10MB]';
  }
  return combined;
}

/**
 * Spawn a Codex CLI process with given args and prompt via stdin.
 * Internal implementation -- use runCodex() which adds concurrency control.
 */
function spawnCodex(
  args: string[],
  prompt: string | undefined,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });

    activeChildren.add(child);

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, SIGKILL_DELAY);
      child.on('close', () => clearTimeout(killTimer));
      activeChildren.delete(child);
      reject(new Error(`Codex timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    /** Mark settled, stop the timeout, and untrack the child process. */
    function finish(): boolean {
      if (settled) return false;
      settled = true;
      clearTimeout(timeoutHandle);
      activeChildren.delete(child);
      return true;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout = appendBuffer(stdout, data.toString());
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr = appendBuffer(stderr, data.toString());
    });

    child.on('close', (code) => {
      if (finish()) resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      if (finish()) reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
    });

    if (prompt) {
      child.stdin.on('error', (err) => {
        if (finish()) {
          child.kill('SIGTERM');
          reject(new Error(`Stdin write error: ${err.message}`));
        }
      });
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}

function assertNotShuttingDown(): void {
  if (shuttingDown) throw new Error('Server is shutting down');
}

/**
 * Run a Codex CLI command with concurrency control (semaphore + stagger).
 */
async function runCodex(
  args: string[],
  prompt: string | undefined,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  await semaphore.acquire();
  try {
    assertNotShuttingDown();
    await enforceStagger();
    // Re-check: killAllChildren() may have been called during the stagger sleep
    assertNotShuttingDown();
    return await spawnCodex(args, prompt, cwd);
  } finally {
    semaphore.release();
  }
}

/**
 * Kill all tracked child processes (SIGTERM, then SIGKILL after 3s).
 */
export function killAllChildren(): void {
  shuttingDown = true;
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch { /* already dead */ }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 3_000);
    child.on('close', () => clearTimeout(killTimer));
  }
  activeChildren.clear();
}

/**
 * One-shot execution: codex exec -m MODEL --json --full-auto
 */
export async function executeOneShot(
  prompt: string,
  model?: string,
  cwd?: string,
): Promise<CodexExecResult> {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(cli.error!);

  const resolvedModel = getModel(model);
  const args = ['exec', '-m', resolvedModel, '--json', '--full-auto'];
  const start = Date.now();

  const { stdout, stderr, code } = await runCodex(args, prompt, cwd);

  if (code !== 0 && !stdout.trim()) {
    throw new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`);
  }

  const parsed = parseCodexJsonl(stdout);

  return {
    response: parsed.response,
    threadId: parsed.threadId,
    model: resolvedModel,
    durationMs: Date.now() - start,
    exitCode: code,
    errors: parsed.errors,
    warnings: parsed.warnings,
  };
}

/**
 * Resume an existing session: codex exec resume THREAD_ID --json --full-auto
 */
export async function executeResume(
  threadId: string,
  prompt: string,
  model?: string,
  cwd?: string,
): Promise<CodexExecResult> {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(cli.error!);

  const resolvedModel = getModel(model);
  const args = ['exec', 'resume', threadId, '-m', resolvedModel, '--json', '--full-auto'];
  const start = Date.now();

  const { stdout, stderr, code } = await runCodex(args, prompt, cwd);

  if (code !== 0 && !stdout.trim()) {
    throw new Error(`Codex resume exited with code ${code}: ${stderr || 'No output'}`);
  }

  const parsed = parseCodexJsonl(stdout);

  return {
    response: parsed.response,
    threadId: parsed.threadId ?? threadId,
    model: resolvedModel,
    durationMs: Date.now() - start,
    exitCode: code,
    errors: parsed.errors,
    warnings: parsed.warnings,
  };
}

/**
 * Fork a session by resuming with a new prompt.
 *
 * Note: `codex fork` is TUI-only and cannot be used non-interactively.
 * We simulate fork by using `codex exec resume` which continues the
 * conversation in the same thread.
 */
export async function executeFork(
  threadId: string,
  prompt?: string,
  model?: string,
  cwd?: string,
): Promise<CodexExecResult> {
  const forkPrompt = prompt ?? 'Continue from where we left off.';
  return executeResume(threadId, forkPrompt, model, cwd);
}

// Test-only exports
export { Semaphore };
export const _test = {
  get semaphore() { return semaphore; },
  get lastStartTime() { return lastStartTime; },
  set lastStartTime(v: number) { lastStartTime = v; },
  resetShutdown() { shuttingDown = false; },
} as const;
