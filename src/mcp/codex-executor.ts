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
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });

    activeChildren.add(child);

    let lastActivity = Date.now();
    let idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);

    function resetIdle() {
      lastActivity = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, IDLE_TIMEOUT);
    }

    function onIdle() {
      if (settled) return;
      const elapsed = Date.now() - lastActivity;
      if (elapsed < IDLE_TIMEOUT) {
        idleTimer = setTimeout(onIdle, IDLE_TIMEOUT - elapsed);
        return;
      }
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

/** Kill all tracked child processes (SIGTERM, then SIGKILL after SIGTERM_GRACE_MS). */
export function killAllChildren(): void {
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
): Promise<CodexExecResult> {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(cli.error!);

  const start = Date.now();
  const { stdout, stderr, code } = await spawnCodex(args, prompt, cwd, onEvent);

  if (code !== 0 && !stdout.trim()) {
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
): Promise<CodexExecResult> {
  const resolvedModel = getModel(model);
  return executeCodex(
    ['exec', '-m', resolvedModel, ...BASE_FLAGS, ...extraFlags(reasoningEffort)],
    prependClaudeMd(prompt), resolvedModel, cwd, onEvent,
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
): Promise<CodexExecResult> {
  const resolvedModel = getModel(model);
  return executeCodex(
    ['exec', 'resume', threadId, '-m', resolvedModel, ...BASE_FLAGS, ...extraFlags(reasoningEffort)],
    prompt,
    resolvedModel,
    cwd,
    onEvent,
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
): Promise<CodexExecResult> {
  const forkPrompt = prompt ?? 'Continue from where we left off.';
  return executeResume(threadId, forkPrompt, model, cwd, reasoningEffort, onEvent);
}

// Test-only exports
export const _test = {
  set claudeMdCache(v: string | undefined) { claudeMdCache = v; },
  prependClaudeMd,
};
