import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hook entry points — absolute paths so tests are independent of cwd resolution.
export const BACKEND_WARM_START_HOOK = join(process.cwd(), 'hooks', 'backend-warm-start.mjs');
export const SESSION_START_HOOK = join(process.cwd(), 'hooks', 'session-start.mjs');
export const SUBAGENT_START_HOOK = join(process.cwd(), 'hooks', 'subagent-start.mjs');
export const KB_MEMO_REMINDER_HOOK = join(process.cwd(), 'hooks', 'kb-memo-reminder.mjs');
export const KB_PROMOTE_GATE_HOOK = join(process.cwd(), 'hooks', 'kb-promote-gate.mjs');
export const KB_LOOKUP_REMINDER_HOOK = join(process.cwd(), 'hooks', 'kb-lookup-reminder.mjs');
export const CLI_RESOLVE_HOOK = join(process.cwd(), 'hooks', 'cli-resolve.mjs');
export const CLI_MONITOR_GUARD_HOOK = join(process.cwd(), 'hooks', 'cli-monitor-guard.mjs');
export const PRE_COMPACT_HOOK = join(process.cwd(), 'hooks', 'pre-compact.mjs');
export const POST_COMPACT_HOOK = join(process.cwd(), 'hooks', 'post-compact.mjs');
export const CORAL_SKILL_VARS_HOOK = join(process.cwd(), 'hooks', 'coral-skill-vars.mjs');
export const HUD_AUTO_UPDATE_HOOK = join(process.cwd(), 'hooks', 'hud-auto-update.mjs');
export const RALPH_LOOP_HOOK = join(process.cwd(), 'hooks', 'ralph-loop.mjs');
export const HOOKS_JSON_PATH = join(process.cwd(), 'hooks', 'hooks.json');

export interface HookRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

export interface CliResolveOutput {
  hookSpecificOutput: {
    hookEventName: string;
    updatedInput: {
      command: string;
    };
  };
}

export interface StopHookOutput {
  decision: string;
  reason: string;
  systemMessage: string;
}

export interface HookFixture {
  root: string;
  tmpRoot: string;
  jobsDir: string;
  pluginRoot: string;
  projectRoot: string;
  snapshotDir: string;
}

const createdRoots: string[] = [];

export function cleanupFixtures(): void {
  for (const root of createdRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

export function createFixture(): HookFixture {
  const root = mkdtempSync(join(tmpdir(), 'coral-hooks-'));
  const tmpRoot = join(root, 'tmp-root');
  const projectRoot = join(root, 'project-root');
  const projectSlug = projectRoot.replace(/\//g, '-');
  const fixture = {
    root,
    tmpRoot,
    jobsDir: join(tmpRoot, 'coral-jobs'),
    pluginRoot: join(root, 'plugin-root'),
    projectRoot,
    snapshotDir: join(tmpRoot, 'coral', projectSlug),
  };

  createdRoots.push(root);
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return fixture;
}

export async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export function runHook(
  hookPath: string,
  stdinJson: object,
  envOverrides: Record<string, string | undefined> = {},
): HookRunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CORAL_CHILD;
  delete env.CORAL_KB_PATH;

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }
  if (env.HOME !== undefined && !Object.hasOwn(envOverrides, 'USERPROFILE')) {
    env.USERPROFILE = env.HOME;
  }

  const result = spawnSync('node', [hookPath], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf-8',
    env,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 0,
  };
}

export async function runHookAsync(
  hookPath: string,
  stdinJson: object,
  envOverrides: Record<string, string | undefined> = {},
): Promise<HookRunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CORAL_CHILD;
  delete env.CORAL_KB_PATH;

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }
  if (env.HOME !== undefined && !Object.hasOwn(envOverrides, 'USERPROFILE')) {
    env.USERPROFILE = env.HOME;
  }

  return await new Promise<HookRunResult>((resolve, reject) => {
    const child = spawn('node', [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.once('error', reject);
    child.once('close', (status) => {
      resolve({ stdout, stderr, status: status ?? 0 });
    });

    child.stdin.end(JSON.stringify(stdinJson));
  });
}

export function parseHookOutput(stdout: string): HookOutput | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;

  try {
    const parsed = JSON.parse(trimmed) as Partial<HookOutput>;
    if (
      parsed.hookSpecificOutput === null || parsed.hookSpecificOutput === undefined ||
      typeof parsed.hookSpecificOutput.hookEventName !== 'string' ||
      typeof parsed.hookSpecificOutput.additionalContext !== 'string'
    ) {
      return null;
    }
    return parsed as HookOutput;
  } catch {
    return null;
  }
}

export function parseJsonOutput<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

export function expectHookOutput(result: HookRunResult): HookOutput {
  const output = parseHookOutput(result.stdout);
  if (output === null) {
    throw new Error(
      `Expected hookSpecificOutput JSON, received stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  return output;
}

export function expectStopOutput(result: HookRunResult): StopHookOutput {
  const output = parseJsonOutput<Partial<StopHookOutput>>(result.stdout);
  if (
    output === null ||
    typeof output.decision !== 'string' ||
    typeof output.reason !== 'string' ||
    typeof output.systemMessage !== 'string'
  ) {
    throw new Error(
      `Expected stop-hook JSON, received stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  return output as StopHookOutput;
}

export function expectCliResolveOutput(result: HookRunResult): CliResolveOutput {
  const output = parseJsonOutput<Partial<CliResolveOutput>>(result.stdout);
  if (
    output === null ||
    output.hookSpecificOutput === null || output.hookSpecificOutput === undefined ||
    output.hookSpecificOutput.hookEventName !== 'PreToolUse' ||
    output.hookSpecificOutput.updatedInput === null || output.hookSpecificOutput.updatedInput === undefined ||
    typeof output.hookSpecificOutput.updatedInput.command !== 'string'
  ) {
    throw new Error(
      `Expected cli-resolve JSON, received stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  return output as CliResolveOutput;
}

export function extractTempInputPaths(command: string): string[] {
  return [...command.matchAll(/coral-input-[0-9a-f]{12}\.txt/g)].map((match) => join(tmpdir(), match[0]));
}

export function writeInjectMd(pluginRoot: string, content: string): void {
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, 'INJECT.md'), content, 'utf-8');
}
