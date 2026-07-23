import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { projectPathKey } from '../../../clients/hooks/lib/plugin-paths.mjs';

// Hook entry points — absolute paths so tests are independent of cwd resolution.
export const SESSION_START_HOOK = join(process.cwd(), 'clients', 'hooks', 'session-start.mjs');
export const SUBAGENT_START_HOOK = join(process.cwd(), 'clients', 'hooks', 'subagent-start.mjs');
export const SUBAGENT_TRACK_HOOK = join(process.cwd(), 'clients', 'hooks', 'subagent-track.mjs');
export const KB_MEMO_REMINDER_HOOK = join(process.cwd(), 'clients', 'hooks', 'kb-memo-reminder.mjs');
export const KB_PROMOTE_GATE_HOOK = join(process.cwd(), 'clients', 'hooks', 'kb-promote-gate.mjs');
export const KB_LOOKUP_REMINDER_HOOK = join(process.cwd(), 'clients', 'hooks', 'kb-lookup-reminder.mjs');
export const BASH_REWRITE_HOOK = join(process.cwd(), 'clients', 'hooks', 'bash-rewrite.mjs');
export const MONITOR_TRACK_HOOK = join(process.cwd(), 'clients', 'hooks', 'monitor-track.mjs');
export const PRE_COMPACT_HOOK = join(process.cwd(), 'clients', 'hooks', 'pre-compact.mjs');
export const POST_COMPACT_HOOK = join(process.cwd(), 'clients', 'hooks', 'post-compact.mjs');
export const CORAL_SKILL_VARS_HOOK = join(process.cwd(), 'clients', 'hooks', 'coral-skill-vars.mjs');
export const HUD_AUTO_UPDATE_HOOK = join(process.cwd(), 'clients', 'hooks', 'hud-auto-update.mjs');
export const RALPH_LOOP_HOOK = join(process.cwd(), 'clients', 'hooks', 'ralph-loop.mjs');
export const CLAUDE_HOOKS_JSON_PATH = join(process.cwd(), 'clients', 'hooks', 'claude.json');
export const CODEX_HOOKS_JSON_PATH = join(process.cwd(), 'clients', 'hooks', 'codex.json');

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

export interface BashRewriteOutput {
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
  workRoot: string;
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
  const fixture = {
    root,
    tmpRoot,
    jobsDir: join(tmpRoot, 'coral-jobs'),
    pluginRoot: join(root, 'plugin-root'),
    projectRoot,
    snapshotDir: join(tmpRoot, 'coral', projectPathKey(projectRoot)),
    // Coral's sandbox-writable /tmp root. In tests it is the fixture's temp root;
    // runHook mirrors it into CORAL_WORK_ROOT_OVERRIDE for the hook subprocess, so
    // projectTmpDir (now nested under sandboxTmpDir) resolves back to snapshotDir.
    workRoot: tmpRoot,
  };

  createdRoots.push(root);
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return fixture;
}

// Live-work registry paths for a session under the sandbox-writable root. Mirrors
// live-work-registry.mjs; pass fixture.workRoot as CORAL_WORK_ROOT_OVERRIDE to the
// hook subprocess so it resolves sandboxTmpDir() to the same place.
export function liveWorkSubagentsDir(fixture: HookFixture, sessionId: string): string {
  return join(fixture.workRoot, 'coral-work', projectPathKey(fixture.projectRoot), sessionId, 'subagents');
}

export function liveWorkBackgroundDir(fixture: HookFixture, sessionId: string): string {
  return join(fixture.workRoot, 'coral-work', projectPathKey(fixture.projectRoot), sessionId, 'bg');
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
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CORAL_WORK_ROOT_OVERRIDE;

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
  // Coral's /tmp state root (sandboxTmpDir) follows the fixture's TMPDIR in tests
  // unless a test sets CORAL_WORK_ROOT_OVERRIDE explicitly.
  if (env.TMPDIR !== undefined && !Object.hasOwn(envOverrides, 'CORAL_WORK_ROOT_OVERRIDE')) {
    env.CORAL_WORK_ROOT_OVERRIDE = env.TMPDIR;
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
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CORAL_WORK_ROOT_OVERRIDE;

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
  // Coral's /tmp state root (sandboxTmpDir) follows the fixture's TMPDIR in tests
  // unless a test sets CORAL_WORK_ROOT_OVERRIDE explicitly.
  if (env.TMPDIR !== undefined && !Object.hasOwn(envOverrides, 'CORAL_WORK_ROOT_OVERRIDE')) {
    env.CORAL_WORK_ROOT_OVERRIDE = env.TMPDIR;
  }

  return await new Promise<HookRunResult>((resolve, reject) => {
    const child = spawn('node', [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

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
      parsed.hookSpecificOutput === null ||
      parsed.hookSpecificOutput === undefined ||
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

export function expectBashRewriteOutput(result: HookRunResult): BashRewriteOutput {
  const output = parseJsonOutput<Partial<BashRewriteOutput>>(result.stdout);
  if (
    output === null ||
    output.hookSpecificOutput === null ||
    output.hookSpecificOutput === undefined ||
    output.hookSpecificOutput.hookEventName !== 'PreToolUse' ||
    output.hookSpecificOutput.updatedInput === null ||
    output.hookSpecificOutput.updatedInput === undefined ||
    typeof output.hookSpecificOutput.updatedInput.command !== 'string'
  ) {
    throw new Error(
      `Expected bash-rewrite JSON, received stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  return output as BashRewriteOutput;
}

export function extractTempInputPaths(command: string): string[] {
  return [...command.matchAll(/coral-input-[0-9a-f]{12}\.txt/g)].map((match) => join(tmpdir(), match[0]));
}

export type InjectBundleFixture = {
  core?: string;
  tools?: string;
  kbCommon?: string;
  kbOrchestrator?: string;
  kbSession?: string;
};

export function writeInjectBundle(pluginRoot: string, input: string | InjectBundleFixture): void {
  const fragments: InjectBundleFixture = typeof input === 'string' ? { core: input } : input;
  const injectRoot = join(pluginRoot, 'inject');
  mkdirSync(join(injectRoot, 'kb'), { recursive: true });
  for (const [relativePath, content] of [
    ['core.md', fragments.core],
    ['tools.md', fragments.tools],
    ['kb/common.md', fragments.kbCommon],
    ['kb/orchestrator.md', fragments.kbOrchestrator],
    ['kb/session.md', fragments.kbSession],
  ] as const) {
    writeFileSync(join(injectRoot, relativePath), content ?? '', 'utf-8');
  }
}
