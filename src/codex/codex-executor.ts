/**
 * Codex CLI execution logic.
 * Never use console.log — this runs inside a stdio MCP server.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexExecResult } from '../types.js';
import { parseCodexJsonl } from './output-parser.js';
import { detectCodexCli } from './cli-detection.js';

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity
const DEFAULT_MODEL = process.env.CORAL_CODEX_MODEL ?? 'gpt-5.3-codex';
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const SIGTERM_GRACE_MS = 5_000; // grace period before escalating to SIGKILL

const activeChildren = new Set<ChildProcess>();

// ─── Active Execution Registry ────────────────────────────────────────────────

const activeExecutions = new Map<string, AbortController>();

/** Register a session as actively executing. Returns the AbortController for signal threading. */
export function registerExecution(sessionName: string): AbortController {
  const existing = activeExecutions.get(sessionName);
  if (existing) existing.abort(); // abort stale execution; AbortController.abort() is idempotent
  const controller = new AbortController();
  activeExecutions.set(sessionName, controller);
  return controller;
}

/**
 * Identity-safe unregister: only removes the entry if the registered controller matches.
 * Prevents a stale finally block from removing a newer run's controller.
 */
export function unregisterExecution(sessionName: string, controller: AbortController): void {
  if (activeExecutions.get(sessionName) === controller) {
    activeExecutions.delete(sessionName);
  }
}

/** Abort a running execution by session name. Returns true if an active execution was found. */
export function abortExecution(sessionName: string): boolean {
  const controller = activeExecutions.get(sessionName);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** List all currently active session names. */
export function listActiveExecutions(): string[] {
  return [...activeExecutions.keys()];
}

function getModel(model?: string): string {
  return model?.trim() || DEFAULT_MODEL;
}

function appendBuffer(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length > MAX_BUFFER) {
    return combined.slice(0, MAX_BUFFER) + '\n[output truncated at 10MB]';
  }
  return combined;
}

/** Spawn a Codex CLI process and collect output. */
function spawnCodex(
  args: string[],
  prompt: string | undefined,
  cwd?: string,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortedBySignal = false;

    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });

    activeChildren.add(child);

    let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);
    }

    function onIdle() {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, SIGTERM_GRACE_MS);
      child.on('close', () => clearTimeout(killTimer));
      activeChildren.delete(child);
      reject(new Error(`Codex killed after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`));
    }

    function finish(): boolean {
      if (settled) return false;
      settled = true;
      clearTimeout(idleTimer);
      activeChildren.delete(child);
      return true;
    }

    if (signal) {
      const onAbort = () => {
        if (settled) return;
        abortedBySignal = true;
        clearTimeout(idleTimer); // prevent idle-timeout rejection racing with abort
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, SIGTERM_GRACE_MS);
        child.on('close', () => clearTimeout(killTimer)); // clean up if process exits before grace period
      };
      if (signal.aborted) { onAbort(); }
      else { signal.addEventListener('abort', onAbort, { once: true }); }
    }

    let stdout = '';
    let stderr = '';
    let lineBuf = '';

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      resetIdle();
      stdout = appendBuffer(stdout, chunk);
      if (onEvent) {
        lineBuf += chunk;
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop()!;
        for (const line of parts) {
          if (line.trim()) onEvent(line);
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      resetIdle();
      stderr = appendBuffer(stderr, data.toString());
    });

    child.on('close', (code) => {
      if (finish()) resolve({ stdout, stderr, code, aborted: abortedBySignal });
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

/** Kill all tracked child processes (SIGTERM, then SIGKILL after SIGTERM_GRACE_MS). */
export function killAllChildren(): void {
  // Abort all registered executions first (signals AbortController listeners)
  for (const [, controller] of activeExecutions) {
    controller.abort();
  }
  activeExecutions.clear();

  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch { /* already dead */ }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, SIGTERM_GRACE_MS);
    child.on('close', () => clearTimeout(killTimer));
  }
  activeChildren.clear();
}

/**
 * Shared execution pipeline: detect CLI, spawn, parse JSONL output.
 */
async function executeCodex(
  args: string[],
  prompt: string,
  resolvedModel: string,
  cwd?: string,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
): Promise<CodexExecResult> {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(cli.error!);

  const start = Date.now();
  const { stdout, stderr, code, aborted } = await spawnCodex(args, prompt, cwd, onEvent, signal);

  if (code !== 0 && !stdout.trim() && !aborted) {
    throw new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`);
  }

  const parsed = parseCodexJsonl(stdout);

  return {
    response: parsed.response,
    threadId: parsed.threadId ?? null,
    model: resolvedModel,
    durationMs: Date.now() - start,
    exitCode: code,
    errors: parsed.errors,
    warnings: parsed.warnings,
    aborted,
  };
}

// CLAUDE.md injection — prepend plugin guidelines to one-shot prompts
declare const __PLUGIN_ROOT__: string;
const pluginRoot: string = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..');
let claudeMdCache: string | undefined;

function getClaudeMd(): string {
  if (claudeMdCache === undefined) {
    try { claudeMdCache = readFileSync(join(pluginRoot, 'CLAUDE.md'), 'utf-8'); }
    catch { claudeMdCache = ''; }
  }
  return claudeMdCache;
}

function prependClaudeMd(prompt: string): string {
  const md = getClaudeMd();
  return md ? `${md}\n\n---\n\n${prompt}` : prompt;
}

/** Base flags shared by all exec modes. Web search is always enabled. */
const BASE_FLAGS = ['--json', '--full-auto', '-c', 'web_search=live'];

/** Build optional CLI flags for reasoning_effort. */
function extraFlags(reasoningEffort?: string): string[] {
  return reasoningEffort ? ['-c', `model_reasoning_effort=${reasoningEffort}`] : [];
}

/** One-shot execution: codex exec -m MODEL --json --full-auto */
export async function executeOneShot(
  prompt: string,
  model?: string,
  cwd?: string,
  reasoningEffort?: string,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
): Promise<CodexExecResult> {
  const resolvedModel = getModel(model);
  return executeCodex(
    ['exec', '-m', resolvedModel, ...BASE_FLAGS, ...extraFlags(reasoningEffort)],
    prependClaudeMd(prompt), resolvedModel, cwd, onEvent, signal,
  );
}

/**
 * Resume an existing session: codex exec resume THREAD_ID --json --full-auto
 */
export async function executeResume(
  threadId: string,
  prompt: string,
  model?: string,
  cwd?: string,
  reasoningEffort?: string,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
): Promise<CodexExecResult> {
  const resolvedModel = getModel(model);
  return executeCodex(
    ['exec', 'resume', threadId, '-m', resolvedModel, ...BASE_FLAGS, ...extraFlags(reasoningEffort)],
    prompt,
    resolvedModel,
    cwd,
    onEvent,
    signal,
  );
}

/** Fork a session by resuming with a new prompt (codex fork is TUI-only). */
export async function executeFork(
  threadId: string,
  prompt?: string,
  model?: string,
  cwd?: string,
  reasoningEffort?: string,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
): Promise<CodexExecResult> {
  const forkPrompt = prompt ?? 'Continue from where we left off.';
  return executeResume(threadId, forkPrompt, model, cwd, reasoningEffort, onEvent, signal);
}

// Test-only exports
export const _test = {
  set claudeMdCache(v: string | undefined) { claudeMdCache = v; },
  prependClaudeMd,
};
