/**
 * Codex CLI execution logic.
 * Never use console.log - this runs inside a stdio MCP server.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexExecResult } from '../types.js';
import { spawnCli, activeChildren, killAllChildren as killAllRunnerChildren } from '../runner/engine.js';
import { parseCodexJsonl } from './output-parser.js';
import { detectCodexCli, type CliInfo } from './cli-detection.js';

const DEFAULT_MODEL = process.env.CORAL_CODEX_MODEL ?? 'gpt-5.3-codex';

function getModel(model?: string): string {
  return model?.trim() || DEFAULT_MODEL;
}

export { killAllRunnerChildren as killAllChildren };

/**
 * Shared execution pipeline: detect CLI, spawn, parse JSONL output.
 */
let multiAgentEnsured = false;

function ensureMultiAgent(): void {
  if (multiAgentEnsured) return;
  try {
    const configPath = join(homedir(), '.codex', 'config.toml');
    if (!existsSync(configPath)) {
      mkdirSync(join(homedir(), '.codex'), { recursive: true });
      writeFileSync(configPath, '[features]\nmulti_agent = true\n');
      multiAgentEnsured = true;
      return;
    }
    const content = readFileSync(configPath, 'utf8');
    if (/multi_agent\s*=\s*true/.test(content)) {
      multiAgentEnsured = true;
      return;
    }
    const lines = content.split('\n').filter((l) => !l.includes('multi_agent'));
    const featIdx = lines.findIndex((l) => /^\[features\]/.test(l));
    if (featIdx >= 0) {
      lines.splice(featIdx + 1, 0, 'multi_agent = true');
    } else {
      lines.push('', '[features]', 'multi_agent = true');
    }
    writeFileSync(configPath, lines.join('\n'));
    multiAgentEnsured = true;
  } catch {
    // Fail-open parity with hook: do not throw, allow retry on next exec call.
  }
}

async function executeCodex(
  args: string[],
  prompt: string,
  resolvedModel: string,
  cwd?: string,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
  preChecked?: CliInfo & { available: true },
): Promise<CodexExecResult> {
  ensureMultiAgent();

  const cli = preChecked ?? await detectCodexCli();
  if (!cli.available) throw new Error(cli.error);
  if (cli.authState === 'unauthenticated') throw new Error(cli.authError);

  const start = Date.now();
  const { stdout, stderr, code, aborted } = await spawnCli({
    provider: 'codex',
    command: 'codex',
    args,
    prompt,
    cwd,
    onEvent,
    signal,
  });

  if (code !== 0 && !stdout.trim() && !aborted) {
    throw new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`);
  }

  const parsed = parseCodexJsonl(stdout);

  return {
    response: parsed.response,
    sessionId: parsed.sessionId ?? null,
    model: resolvedModel,
    durationMs: Date.now() - start,
    exitCode: code,
    errors: parsed.errors,
    warnings: parsed.warnings,
    aborted,
  };
}

// CLAUDE.md injection - prepend plugin guidelines to one-shot prompts
declare const __PLUGIN_ROOT__: string;
const pluginRoot: string = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..');
let claudeMdCache: string | undefined;

function getClaudeMd(): string {
  if (claudeMdCache !== undefined) return claudeMdCache;

  try {
    claudeMdCache = readFileSync(join(pluginRoot, 'CLAUDE.md'), 'utf-8');
  } catch {
    claudeMdCache = '';
  }

  return claudeMdCache;
}

function prependClaudeMd(prompt: string): string {
  const md = getClaudeMd();
  return md ? `${md}\n\n---\n\n${prompt}` : prompt;
}

/** Base flags shared by all exec modes. Web search is always enabled. */
function baseFlags(bypassSandbox: boolean): string[] {
  return [
    '--json',
    '--skip-git-repo-check',
    bypassSandbox ? '--dangerously-bypass-approvals-and-sandbox' : '--full-auto',
    '-c', 'web_search=live',
    ...bypassSandbox ? [] : [
      '-c', 'sandbox_mode=workspace-write',
      '-c', 'sandbox_workspace_write.network_access=true',
    ],
  ];
}

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
  bypassSandbox = false,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
  preChecked?: CliInfo & { available: true },
): Promise<CodexExecResult> {
  const resolvedModel = getModel(model);
  return executeCodex(
    ['exec', '-m', resolvedModel, ...baseFlags(bypassSandbox), ...extraFlags(reasoningEffort)],
    prependClaudeMd(prompt), resolvedModel, cwd, onEvent, signal, preChecked,
  );
}

/** Resume an existing session: codex exec resume THREAD_ID --json --full-auto */
export async function executeResume(
  threadId: string,
  prompt: string,
  model?: string,
  cwd?: string,
  reasoningEffort?: string,
  bypassSandbox = false,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
  preChecked?: CliInfo & { available: true },
): Promise<CodexExecResult> {
  const resolvedModel = getModel(model);
  return executeCodex(
    ['exec', 'resume', threadId, '-m', resolvedModel, ...baseFlags(bypassSandbox), ...extraFlags(reasoningEffort)],
    prompt,
    resolvedModel,
    cwd,
    onEvent,
    signal,
    preChecked,
  );
}

/** Fork a session by resuming with a new prompt (codex fork is TUI-only). */
export async function executeFork(
  threadId: string,
  prompt?: string,
  model?: string,
  cwd?: string,
  reasoningEffort?: string,
  bypassSandbox = false,
  onEvent?: (line: string) => void,
  signal?: AbortSignal,
  preChecked?: CliInfo & { available: true },
): Promise<CodexExecResult> {
  const forkPrompt = prompt ?? 'Continue from where we left off.';
  return executeResume(threadId, forkPrompt, model, cwd, reasoningEffort, bypassSandbox, onEvent, signal, preChecked);
}

// Test-only exports
export const _test = {
  set claudeMdCache(v: string | undefined) { claudeMdCache = v; },
  setMultiAgentEnsured(v: boolean) { multiAgentEnsured = v; },
  prependClaudeMd,
  activeChildren,
};
