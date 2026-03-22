/**
 * Codex CLI execution logic.
 * Never use console.log - this runs inside a stdio MCP server.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexExecResult } from './types.js';
import { spawnCli, killAllChildren as killAllRunnerChildren } from '../../execution/engine.js';
import type { EffortLevel } from '../../shared/schemas.js';
import { parseCodexJsonl } from './output-parser.js';
import type { CliInfo } from '../cli-detection.js';
import { kbRoot, projectDataDir, resolveProjectSource } from '../../client/paths.js';

export interface CodexExecOptions {
  model?: string;
  workingDirectory?: string;
  effort?: EffortLevel;
  bypassSandbox?: boolean;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
  preChecked: CliInfo & { available: true };
  environment: Record<string, string>;
}

const VALID_CODEX_EFFORT = new Set(['low', 'medium', 'high', 'xhigh']);

/** Resolve default effort to Codex-native CLI value. */
function resolveCodexDefaultEffort(env: Record<string, string>): string {
  if (env.CORAL_CODEX_EFFORT !== undefined) {
    const raw = env.CORAL_CODEX_EFFORT;
    if (!VALID_CODEX_EFFORT.has(raw)) {
      throw new Error(`Invalid CORAL_CODEX_EFFORT="${raw}". Valid values: low, medium, high, xhigh`);
    }
    return raw;
  }

  const shared = env.CORAL_EFFORT;
  if (shared !== undefined) return toCodexEffort(shared as NonNullable<EffortLevel>);
  return 'xhigh';
}

function getDefaultModel(env: Record<string, string>): string {
  return env.CORAL_CODEX_MODEL ?? 'gpt-5.4';
}

export { killAllRunnerChildren as killAllChildren };

/**
 * Shared execution pipeline: detect CLI, spawn, parse JSONL output.
 */
let multiAgentEnsured = false;
const MULTI_AGENT_CONFIG = '[features]\nmulti_agent = true\n';

function withMultiAgentEnabled(content: string): string {
  const lines = content.split('\n').filter((line) => !line.includes('multi_agent'));
  const featuresIndex = lines.findIndex((line) => /^\[features\]/.test(line));
  if (featuresIndex >= 0) {
    lines.splice(featuresIndex + 1, 0, 'multi_agent = true');
  } else {
    lines.push('', '[features]', 'multi_agent = true');
  }
  return lines.join('\n');
}

function ensureMultiAgent(): void {
  if (multiAgentEnsured) return;
  try {
    const codexDir = join(homedir(), '.codex');
    const configPath = join(codexDir, 'config.toml');
    if (!existsSync(configPath)) {
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(configPath, MULTI_AGENT_CONFIG);
    } else {
      const content = readFileSync(configPath, 'utf8');
      if (!/multi_agent\s*=\s*true/.test(content)) {
        writeFileSync(configPath, withMultiAgentEnabled(content));
      }
    }

    multiAgentEnsured = true;
  } catch {
    // Fail-open parity with hook: do not throw, allow retry on next exec call.
  }
}

async function executeCodex(
  args: string[],
  prompt: string,
  resolvedModel: string,
  opts: CodexExecOptions,
): Promise<CodexExecResult> {
  ensureMultiAgent();

  const cli = opts.preChecked;
  if (cli.authState === 'unauthenticated') throw new Error(cli.authError);

  const start = Date.now();
  const { stdout, stderr, code, aborted } = await spawnCli({
    provider: 'codex',
    command: 'codex',
    args,
    prompt,
    cwd: opts.workingDirectory,
    onEvent: opts.onEvent,
    signal: opts.signal,
  });

  if (code !== 0 && !stdout.trim() && !aborted) {
    throw new Error(`Codex exited with code ${code}: ${stderr || 'No output'}`);
  }

  const parsed = parseCodexJsonl(stdout);
  if (parsed.isError && !aborted) {
    throw new Error('Codex produced no meaningful output (no assistant content, no errors)');
  }

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

// INJECT.md injection - prepend plugin guidelines to one-shot prompts
declare const __PLUGIN_ROOT__: string;
const pluginRoot: string = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..');
let injectMdCache: string | undefined;

function getInjectMd(): string {
  if (injectMdCache !== undefined) return injectMdCache;

  try {
    injectMdCache = readFileSync(join(pluginRoot, 'INJECT.md'), 'utf-8');
  } catch {
    injectMdCache = '';
  }

  return injectMdCache;
}

function prependInjectMd(prompt: string, workingDirectory?: string): string {
  const md = getInjectMd();
  if (!md) return prompt;

  const substitutedMd = md
    .replaceAll('{{CORAL_KB}}', kbRoot())
    .replaceAll('{{CORAL_PROJECTS}}', workingDirectory ? projectDataDir(workingDirectory) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', workingDirectory ? resolveProjectSource(workingDirectory) : '{{PROJECT_SOURCE}}');

  return `${substitutedMd}\n\n---\n\n${prompt}`;
}

/** Base flags shared by all exec modes. Web search is always enabled. */
function baseFlags(bypassSandbox: boolean): string[] {
  const flags = [
    '--json',
    '--skip-git-repo-check',
    bypassSandbox ? '--dangerously-bypass-approvals-and-sandbox' : '--full-auto',
    '-c', 'web_search=live',
  ];

  if (!bypassSandbox) {
    flags.push(
      '-c', 'sandbox_mode=workspace-write',
      '-c', 'sandbox_workspace_write.network_access=true',
    );
  }

  return flags;
}

/** Map internal EffortLevel to Codex CLI value. */
function toCodexEffort(effort: NonNullable<EffortLevel>): string {
  return effort === 'max' ? 'xhigh' : effort;
}

/** Build CLI flags for reasoning effort. */
function reasoningEffortFlags(effort: EffortLevel | undefined, env: Record<string, string>): string[] {
  const value = effort !== undefined ? toCodexEffort(effort) : resolveCodexDefaultEffort(env);
  return ['-c', `model_reasoning_effort=${value}`];
}

/** One-shot execution: codex exec -m MODEL --json --full-auto */
export async function executeOneShot(
  prompt: string,
  opts: CodexExecOptions,
): Promise<CodexExecResult> {
  const resolvedModel = resolveModel(opts);
  return executeCodex(
    buildExecutionArgs(['exec'], resolvedModel, opts),
    prependInjectMd(prompt, opts.workingDirectory),
    resolvedModel,
    opts,
  );
}

/** Resume an existing session: codex exec resume THREAD_ID --json --full-auto */
export async function executeResume(
  threadId: string,
  prompt: string,
  opts: CodexExecOptions,
): Promise<CodexExecResult> {
  const resolvedModel = resolveModel(opts);
  return executeCodex(
    buildExecutionArgs(['exec', 'resume', threadId], resolvedModel, opts),
    prompt,
    resolvedModel,
    opts,
  );
}

/** Fork a session by resuming with a new prompt (codex fork is TUI-only). */
export async function executeFork(
  threadId: string,
  prompt: string,
  opts: CodexExecOptions,
): Promise<CodexExecResult> {
  return executeResume(threadId, prompt, opts);
}

function resolveModel(opts: CodexExecOptions): string {
  return opts.model ?? getDefaultModel(opts.environment);
}

function buildExecutionArgs(
  command: string[],
  model: string,
  opts: CodexExecOptions,
): string[] {
  return [
    ...command,
    '-m',
    model,
    ...baseFlags(opts.bypassSandbox ?? false),
    ...reasoningEffortFlags(opts.effort, opts.environment),
  ];
}
