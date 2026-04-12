import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BACKEND_WARM_START_HOOK = join(process.cwd(), 'hooks', 'backend-warm-start.mjs');
const SESSION_START_HOOK = join(process.cwd(), 'hooks', 'session-start.mjs');
const SUBAGENT_START_HOOK = join(process.cwd(), 'hooks', 'subagent-start.mjs');
const KB_MEMO_REMINDER_HOOK = join(process.cwd(), 'hooks', 'kb-memo-reminder.mjs');
const KB_PROMOTE_GATE_HOOK = join(process.cwd(), 'hooks', 'kb-promote-gate.mjs');
const KB_LOOKUP_REMINDER_HOOK = join(process.cwd(), 'hooks', 'kb-lookup-reminder.mjs');
const CLI_RESOLVE_HOOK = join(process.cwd(), 'hooks', 'cli-resolve.mjs');
const PRE_COMPACT_HOOK = join(process.cwd(), 'hooks', 'pre-compact.mjs');
const POST_COMPACT_HOOK = join(process.cwd(), 'hooks', 'post-compact.mjs');
const HOOKS_JSON_PATH = join(process.cwd(), 'hooks', 'hooks.json');

const createdRoots: string[] = [];

interface HookRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

interface CliResolveOutput {
  hookSpecificOutput: {
    hookEventName: string;
    updatedInput: {
      command: string;
    };
  };
}

interface StopHookOutput {
  decision: string;
  reason: string;
  systemMessage: string;
}

interface JobStatus {
  jobId: string;
  phase: string;
  projectRoot: string;
  provider: string;
  sessionId: string;
  jobKind?: string;
  result?: {
    workflow?: unknown;
  };
}

interface SnapshotJob {
  jobId: string;
  phase: string;
  provider: string;
  sessionId: string;
  jobKind?: string;
}

interface SnapshotRecord {
  capturedAtMs: number;
  projectRoot: string;
  sourceSessionId: string | null;
  jobs: SnapshotJob[];
}

interface HookFixture {
  root: string;
  tmpRoot: string;
  jobsDir: string;
  pluginRoot: string;
  projectRoot: string;
  snapshotDir: string;
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function createFixture(): HookFixture {
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

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function runHook(
  hookPath: string,
  stdinJson: object,
  envOverrides: Record<string, string | undefined> = {},
): HookRunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CORAL_CHILD;

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }

    env[key] = value;
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

async function runHookAsync(
  hookPath: string,
  stdinJson: object,
  envOverrides: Record<string, string | undefined> = {},
): Promise<HookRunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CORAL_CHILD;

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }

    env[key] = value;
  }

  return await new Promise<HookRunResult>((resolve, reject) => {
    const child = spawn('node', [hookPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
      resolve({
        stdout,
        stderr,
        status: status ?? 0,
      });
    });

    child.stdin.end(JSON.stringify(stdinJson));
  });
}

function parseHookOutput(stdout: string): HookOutput | null {
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

function parseJsonOutput<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

function expectHookOutput(result: HookRunResult): HookOutput {
  const output = parseHookOutput(result.stdout);
  if (output === null || output === undefined) {
    throw new Error(
      `Expected hookSpecificOutput JSON, received stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }

  return output;
}

function expectStopOutput(result: HookRunResult): StopHookOutput {
  const output = parseJsonOutput<Partial<StopHookOutput>>(result.stdout);
  if (
    output === null || output === undefined ||
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

function expectCliResolveOutput(result: HookRunResult): CliResolveOutput {
  const output = parseJsonOutput<Partial<CliResolveOutput>>(result.stdout);
  if (
    output === null || output === undefined ||
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

function extractTempInputPaths(command: string): string[] {
  return [...command.matchAll(/coral-input-[0-9a-f]{12}\.txt/g)].map((match) => join(tmpdir(), match[0]));
}

function writeInjectMd(pluginRoot: string, content: string): void {
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, 'INJECT.md'), content, 'utf-8');
}

function initGitRepo(projectRoot: string, remote: string): void {
  execFileSync('git', ['init', '-q'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: projectRoot, stdio: 'ignore' });
}

function coralProjectDir(homeDir: string, source: string): string {
  return join(homeDir, '.coral', 'projects', source.replace(/\//g, '-'));
}

function writeStatus(jobsDir: string, status: JobStatus): void {
  const jobDir = join(jobsDir, status.jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'status.json'), JSON.stringify(status), 'utf-8');
}

function writeCorruptStatus(jobsDir: string, jobId: string, raw: string): void {
  const jobDir = join(jobsDir, jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'status.json'), raw, 'utf-8');
}

function writeResultArtifact(jobsDir: string, jobId: string, content = '# result'): void {
  const jobDir = join(jobsDir, jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'result.md'), content, 'utf-8');
}

function writeSnapshot(snapshotDir: string, snapshot: SnapshotRecord, suffix = 'fixture'): string {
  mkdirSync(snapshotDir, { recursive: true });

  const snapshotPath = join(snapshotDir, `active-jobs-${snapshot.capturedAtMs}-${suffix}.json`);

  writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf-8');
  return snapshotPath;
}

function listSnapshots(snapshotDir: string): string[] {
  if (!existsSync(snapshotDir)) return [];

  return readdirSync(snapshotDir)
    .filter((fileName) => fileName.startsWith('active-jobs-') && fileName.endsWith('.json'))
    .map((fileName) => join(snapshotDir, fileName))
    .sort((left, right) => left.localeCompare(right));
}

describe('backend-warm-start.mjs', () => {
  async function setupWarmStartFixture(expectedFlavor: 'prod' | 'dev', liveFlavor: 'prod' | 'dev') {
    const fixture = createFixture();
    const markerPath = join(fixture.pluginRoot, 'spawned.txt');
    const token = `${expectedFlavor}-${liveFlavor}-token`;

    mkdirSync(join(fixture.pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'test-hash', flavor: expectedFlavor }),
      'utf-8',
    );
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'coral-backend.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')\n`,
      'utf-8',
    );

    const namespace = createHash('sha256').update(realpathSync(fixture.pluginRoot)).digest('hex').slice(0, 12);
    const installDir = join(fixture.root, '.claude', 'coral', 'installations', namespace);
    mkdirSync(installDir, { recursive: true });

    let shutdownCount = 0;
    const server = createServer((req, res) => {
      if (req.headers['x-coral-backend-token'] !== token) {
        res.statusCode = 401;
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: liveFlavor,
            instanceId: `${liveFlavor}-instance`,
            namespace,
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/admin/shutdown') {
        shutdownCount += 1;
        res.statusCode = 200;
        res.end(JSON.stringify({ status: 'draining' }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address for backend-warm-start test');
    }

    writeFileSync(
      join(installDir, 'backend.json'),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        host: '127.0.0.1',
        token,
        version: '0.0.0',
        bundleHash: 'test-hash',
        flavor: liveFlavor,
        instanceId: `${liveFlavor}-instance`,
        namespace,
        startedAt: Date.now(),
      }),
      'utf-8',
    );

    return {
      fixture,
      markerPath,
      shutdownCount: () => shutdownCount,
      closeServer: async () =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    };
  }

  it('exits early without spawning when the live backend already matches the manifest flavor', async () => {
    const setup = await setupWarmStartFixture('prod', 'prod');
    try {
      const result = await runHookAsync(BACKEND_WARM_START_HOOK, {}, {
        HOME: setup.fixture.root,
        CLAUDE_PLUGIN_ROOT: setup.fixture.pluginRoot,
      });

      expect(result.status).toBe(0);
      expect(await waitForFile(setup.markerPath)).toBe(false);
      expect(setup.shutdownCount()).toBe(0);
    } finally {
      await setup.closeServer();
    }
  });

  it('requests shutdown and spawns a replacement when the live backend flavor differs from the manifest flavor', async () => {
    const setup = await setupWarmStartFixture('dev', 'prod');
    try {
      const result = await runHookAsync(BACKEND_WARM_START_HOOK, {}, {
        HOME: setup.fixture.root,
        CLAUDE_PLUGIN_ROOT: setup.fixture.pluginRoot,
      });

      expect(result.status).toBe(0);
      expect(await waitForFile(setup.markerPath)).toBe(true);
      expect(setup.shutdownCount()).toBe(1);
    } finally {
      await setup.closeServer();
    }
  });
});

describe('cli-resolve.mjs', () => {
  const cliBundle = join(process.cwd(), 'bridge', 'coral-cli.cjs');
  const createdTempInputs: string[] = [];

  afterEach(() => {
    for (const filePath of createdTempInputs.splice(0)) {
      rmSync(filePath, { force: true });
    }
  });

  function rememberTempInputs(command: string): string[] {
    const tempPaths = extractTempInputPaths(command);
    createdTempInputs.push(...tempPaths);
    return tempPaths;
  }

  function expectedRewrittenCommand(command: string): string {
    return command.replace(/^(\s*)coral-cli(\s|$)(.*)$/s, `$1node "${cliBundle}"$2$3`);
  }

  it('extracts provider -i quoted text to a temp file, skips top-level --output-format, and leaves provider -s untouched', () => {
    const fixture = createFixture();
    const command = 'coral-cli --output-format json codex -s session-1 -i "text with $HOME and `backticks`"';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain(`node "${cliBundle}" --output-format json codex`);
    expect(rewritten).toContain('-s session-1');
    expect(rewritten).not.toContain('text with $HOME and `backticks`');
    expect(tempPaths).toHaveLength(1);
    expect(existsSync(tempPaths[0])).toBe(true);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('text with $HOME and `backticks`');
  });

  it('extracts workflow -s and -c text with mixed quote forms while skipping top-level -f', () => {
    const fixture = createFixture();
    const command = 'coral-cli -f json workflow architect -s\'start prompt\' --context="ctx \\\"quoted\\\""';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain(`node "${cliBundle}" -f json workflow architect`);
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths.map((filePath) => readFileSync(filePath, 'utf-8'))).toEqual([
      'start prompt',
      'ctx "quoted"',
    ]);
  });

  it('preserves quoted existing file paths for provider -i relative to input.cwd', () => {
    const fixture = createFixture();
    const promptsDir = join(fixture.projectRoot, 'prompts');
    const promptPath = join(promptsDir, 'alpha prompt.md');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(promptPath, '# prompt', 'utf-8');

    const command = 'coral-cli codex -i "./prompts/alpha prompt.md"';
    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
    expect(rewritten).toContain('"./prompts/alpha prompt.md"');
    expect(extractTempInputPaths(rewritten)).toHaveLength(0);
  });

  it.each([
    ['unquoted expansion', 'coral-cli codex -i $HOME/prompt.md'],
    ['control operators', 'coral-cli codex -i "prompt" && echo done'],
    ['ambiguous short cluster', 'coral-cli codex -bi "prompt"'],
    ['unquoted backslash-escaped literal', 'coral-cli codex -i hello\\ world'],
    ['unterminated quoting', 'coral-cli codex -i "unterminated'],
  ])('fails open for %s', (_label, command) => {
    const fixture = createFixture();

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
    expect(extractTempInputPaths(rewritten)).toHaveLength(0);
  });

  it('wraps unquoted tokens containing parentheses in single quotes after rewriting the quoted prompt', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i "hello" func(x)';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(readFileSync(tempPaths[0], 'utf-8')).toBe('hello');
    expect(rewritten).toContain("'func(x)'");
    expect(rewritten).not.toMatch(/\sfunc\(x\)(\s|$)/);
  });

  it('wraps unquoted parenthesized tokens even when the -i value itself is unquoted', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i Check func(x)';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(extractTempInputPaths(rewritten)).toHaveLength(0);
    expect(rewritten).toContain(' -i Check ');
    expect(rewritten).toContain("'func(x)'");
  });

  it.each([
    ['square brackets', 'arr[0]'],
    ['curly braces', '{a,b}'],
    ['mixed brackets and parens', 'fn(x)[0]'],
  ])('wraps unquoted tokens containing %s after a quoted -i value', (_label, orphanToken) => {
    const fixture = createFixture();
    const command = `coral-cli codex agent -i "hello" ${orphanToken}`;

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(tempPaths).toHaveLength(1);
    expect(rewritten).toContain(`'${orphanToken}'`);
  });

  it('leaves tokens without shell metacharacters untouched', () => {
    const fixture = createFixture();
    const command = 'coral-cli codex agent -i hello world';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;

    expect(rewritten).toBe(expectedRewrittenCommand(command));
  });

  it('preserves the workflow -e expression with parens inside double quotes', () => {
    const fixture = createFixture();
    const command = 'coral-cli workflow -e "(a,b)" -s "do thing" -c "ctx"';

    const result = runHook(CLI_RESOLVE_HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixture.projectRoot,
      tool_input: { command },
    });

    expect(result.status).toBe(0);

    const output = expectCliResolveOutput(result);
    const rewritten = output.hookSpecificOutput.updatedInput.command;
    const tempPaths = rememberTempInputs(rewritten);

    expect(rewritten).toContain('-e "(a,b)"');
    expect(tempPaths).toHaveLength(2);
    expect(tempPaths.map((filePath) => readFileSync(filePath, 'utf-8')).sort()).toEqual(['ctx', 'do thing']);
  });
});

describe('session-start.mjs', () => {
  it('outputs INJECT.md with session_id when both provided', () => {
    const fixture = createFixture();
    const injectMd = 'Project instructions\nSecond line';
    writeInjectMd(fixture.pluginRoot, injectMd);

    const result = runHook(SESSION_START_HOOK, { session_id: 'sess-123' }, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext.startsWith('SessionStart:session_id=sess-123\n\n')).toBe(true);
    expect(output.hookSpecificOutput.additionalContext).toContain(injectMd);
  });

  it('replaces {{CORAL_PROJECTS}} with the source-derived global project dir', () => {
    const fixture = createFixture();
    initGitRepo(fixture.projectRoot, 'https://token@github.com/acme/my.repo.git');
    writeInjectMd(fixture.pluginRoot, 'Memo dir: {{CORAL_PROJECTS}}/memo');

    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-123' },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain(
      `Memo dir: ${coralProjectDir(fixture.root, 'acme/my.repo')}/memo`,
    );
  });

  it('replaces {{CORAL_CLI}} with the shell-quoted coral-cli bridge path', () => {
    const fixture = createFixture();
    writeInjectMd(fixture.pluginRoot, 'KB: {{CORAL_CLI}} kb principles');

    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toBe(
      `KB: node "${join(fixture.pluginRoot, 'bridge', 'coral-cli.cjs')}" kb principles`,
    );
  });

  it('outputs INJECT.md only when no session_id', () => {
    const fixture = createFixture();
    const injectMd = 'Only CLAUDE content';
    writeInjectMd(fixture.pluginRoot, injectMd);

    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext.startsWith('SessionStart:')).toBe(false);
    expect(output.hookSpecificOutput.additionalContext).toBe(injectMd);
  });

  it('exits cleanly when CLAUDE_PLUGIN_ROOT unset', () => {
    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: undefined });

    expect(result.status).toBe(0);
    expect(parseHookOutput(result.stdout)).toBeNull();
  });

  it('strips SESSION_ID_ONLY block when session_id is missing', () => {
    const fixture = createFixture();
    writeInjectMd(
      fixture.pluginRoot,
      'visible\n<!-- SESSION_ID_ONLY:BEGIN -->\nsecret\n<!-- SESSION_ID_ONLY:END -->\nafter',
    );

    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('visible');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('secret');
    expect(output.hookSpecificOutput.additionalContext).toContain('after');
  });

  it('keeps OWNER_ONLY block for top-level sessions', () => {
    const fixture = createFixture();
    writeInjectMd(
      fixture.pluginRoot,
      'base\n<!-- OWNER_ONLY:BEGIN -->\nowner instruction\n<!-- OWNER_ONLY:END -->\nrest',
    );

    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-owner' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('owner instruction');
  });
});

describe('subagent-start.mjs', () => {
  it('outputs INJECT.md with SubagentStart hookEventName', () => {
    const fixture = createFixture();
    writeInjectMd(fixture.pluginRoot, 'Guidelines for subagent');

    const result = runHook(
      SUBAGENT_START_HOOK,
      { session_id: 'sess-parent' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('Guidelines for subagent');
  });

  it('strips SESSION_ID_ONLY blocks', () => {
    const fixture = createFixture();
    writeInjectMd(
      fixture.pluginRoot,
      'visible\n<!-- SESSION_ID_ONLY:BEGIN -->\nmemo commands\n<!-- SESSION_ID_ONLY:END -->\nafter',
    );

    const result = runHook(
      SUBAGENT_START_HOOK,
      { session_id: 'sess-parent' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('visible');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('memo commands');
    expect(output.hookSpecificOutput.additionalContext).toContain('after');
  });

  it('strips OWNER_ONLY blocks', () => {
    const fixture = createFixture();
    writeInjectMd(
      fixture.pluginRoot,
      'base\n<!-- OWNER_ONLY:BEGIN -->\npropagate owner\n<!-- OWNER_ONLY:END -->\nrest',
    );

    const result = runHook(
      SUBAGENT_START_HOOK,
      { session_id: 'sess-parent' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('base');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('propagate owner');
    expect(output.hookSpecificOutput.additionalContext).toContain('rest');
  });

  it('replaces {{CORAL_CLI}} with bridge path', () => {
    const fixture = createFixture();
    writeInjectMd(fixture.pluginRoot, 'CLI: {{CORAL_CLI}}');

    const result = runHook(SUBAGENT_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toBe(
      `CLI: node "${join(fixture.pluginRoot, 'bridge', 'coral-cli.cjs')}"`,
    );
  });

  it('exits cleanly when CLAUDE_PLUGIN_ROOT unset', () => {
    const result = runHook(SUBAGENT_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: undefined });

    expect(result.status).toBe(0);
    expect(parseHookOutput(result.stdout)).toBeNull();
  });
});

describe('kb-memo-reminder.mjs', () => {
  it('reminds with the source-derived global memo path', () => {
    const fixture = createFixture();
    initGitRepo(fixture.projectRoot, 'git@gitlab.com:group/subgroup/repo.git');

    const result = runHook(
      KB_MEMO_REMINDER_HOOK,
      { session_id: 'sess-1' },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('kb memo write --owner "sess-1"');
  });
});

describe('kb-promote-gate.mjs', () => {
  it('reads memos from the global project dir and blocks stop with memo-review guidance', () => {
    const fixture = createFixture();
    const memoDir = join(coralProjectDir(fixture.root, `local/${basename(fixture.projectRoot)}`), 'memo');
    mkdirSync(memoDir, { recursive: true });
    // Gate threshold is 10 — create enough memos to trigger block
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(memoDir, `20260321-hooks-note-${i}.md`), 'memo', 'utf-8');
    }

    runHook(
      KB_PROMOTE_GATE_HOOK,
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', user_message: '/coral:ralph' },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
      },
    );

    const result = runHook(
      KB_PROMOTE_GATE_HOOK,
      { hook_event_name: 'Stop', session_id: 'sess-1' },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);

    const output = expectStopOutput(result);
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('kb search');
    expect(output.reason).toContain('kb promote');
    expect(output.reason).toContain('memo -> review -> promotion');
    expect(output.reason).not.toContain('.coral/kb/notes/');
    expect(output.reason).not.toContain('write directly');
    expect(output.reason).toContain('20260321-hooks-note-0.md');
  });

  it('keeps compact SessionStart guidance on the memo-review workflow', () => {
    const fixture = createFixture();
    const memoDir = join(coralProjectDir(fixture.root, `local/${basename(fixture.projectRoot)}`), 'memo');
    mkdirSync(memoDir, { recursive: true });
    writeFileSync(join(memoDir, '20260321-hooks-note.md'), 'memo', 'utf-8');

    const result = runHook(
      KB_PROMOTE_GATE_HOOK,
      { hook_event_name: 'SessionStart' },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('kb search');
    expect(output.hookSpecificOutput.additionalContext).toContain('kb promote');
    expect(output.hookSpecificOutput.additionalContext).toContain('memo -> review -> promotion');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('.coral/kb/notes/');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('write directly');
  });
});

describe('kb-lookup-reminder.mjs', () => {
  it('reads KB topics from resolved kb/notes/', () => {
    const fixture = createFixture();
    const kbDir = join(fixture.root, '.coral', 'kb', 'notes');
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, 'hooks-paths.md'), '# Hooks', 'utf-8');
    writeFileSync(join(kbDir, 'codex-placeholder.md'), '# Codex', 'utf-8');

    const result = runHook(KB_LOOKUP_REMINDER_HOOK, { hook_event_name: 'PostToolUseFailure' }, { HOME: fixture.root });

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('kb search');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('.coral/kb/notes/');
    expect(output.hookSpecificOutput.additionalContext).toContain('KB topics: codex, hooks');
  });
});

describe('hooks.json', () => {
  it('does not reference migrate-coral-dir.mjs', () => {
    expect(readFileSync(HOOKS_JSON_PATH, 'utf-8')).not.toContain('migrate-coral-dir.mjs');
  });
});

describe('pre-compact.mjs', () => {
  it('writes snapshot when active jobs exist for this project', () => {
    const fixture = createFixture();
    const liveJob: JobStatus = {
      jobId: 'test-job-live',
      phase: 'running',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-1',
    };
    writeStatus(fixture.jobsDir, liveJob);

    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-1', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const snapshots = listSnapshots(fixture.snapshotDir);
    expect(snapshots).toHaveLength(1);

    const snapshot = JSON.parse(readFileSync(snapshots[0], 'utf-8')) as SnapshotRecord;
    expect(snapshot.projectRoot).toBe(fixture.projectRoot);
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({
      jobId: 'test-job-live',
      phase: 'running',
      provider: 'codex',
      sessionId: 'sess-1',
    });
  });

  it('does not write snapshot when no matching jobs', () => {
    const fixture = createFixture();
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-completed',
      phase: 'completed',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-1',
    });

    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-1', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(listSnapshots(fixture.snapshotDir)).toHaveLength(0);
  });

  it('skips corrupt job dirs (fail isolation)', () => {
    const fixture = createFixture();
    writeCorruptStatus(fixture.jobsDir, 'test-job-corrupt', '{ not valid json }');
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-valid',
      phase: 'running',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-2',
    });

    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-2', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const snapshots = listSnapshots(fixture.snapshotDir);
    expect(snapshots).toHaveLength(1);

    const snapshot = JSON.parse(readFileSync(snapshots[0], 'utf-8')) as SnapshotRecord;
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.jobId).toBe('test-job-valid');
  });

  it('exits silently when no JOBS_DIR', () => {
    const fixture = createFixture();

    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-3', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(listSnapshots(fixture.snapshotDir)).toHaveLength(0);
  });
});

describe('post-compact.mjs', () => {
  it('outputs pending jobs with wait() action', () => {
    const fixture = createFixture();
    const snapshot: SnapshotRecord = {
      capturedAtMs: Date.now(),
      projectRoot: fixture.projectRoot,
      sourceSessionId: 'sess-1',
      jobs: [
        { jobId: 'test-job-pending-a', phase: 'running', provider: 'codex', sessionId: 'sess-a' },
        { jobId: 'test-job-pending-b', phase: 'queued', provider: 'codex', sessionId: 'sess-b' },
      ],
    };
    writeSnapshot(fixture.snapshotDir, snapshot, 'pending');
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-pending-a',
      phase: 'running',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-a',
    });
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-pending-b',
      phase: 'queued',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-b',
    });

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain('Pending:');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Run coral-cli wait --jobs test-job-pending-a,test-job-pending-b --output-format json to resume monitoring.',
    );
    expect(output.hookSpecificOutput.additionalContext).toContain('test-job-pending-a');
    expect(output.hookSpecificOutput.additionalContext).toContain('test-job-pending-b');
  });

  it('outputs terminal guidance for completed provider job with no artifact', () => {
    const fixture = createFixture();
    writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now(),
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-complete-no-artifact', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'provider-terminal',
    );
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-complete-no-artifact',
      phase: 'completed',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-1',
    });

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('Completed during compaction:');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Use coral-cli wait --jobs "test-job-complete-no-artifact" --output-format json --embed to attempt replay.',
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Read event.result.content from the terminal JSON line if present; otherwise Read(event.result.path) for the full artifact.',
    );
  });

  it('outputs Read path for completed job with result.md', () => {
    const fixture = createFixture();
    writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now(),
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-with-result', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'artifact',
    );
    writeStatus(fixture.jobsDir, {
      jobId: 'test-job-with-result',
      phase: 'completed',
      projectRoot: fixture.projectRoot,
      provider: 'codex',
      sessionId: 'sess-1',
    });
    writeResultArtifact(fixture.jobsDir, 'test-job-with-result');

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('Read ');
    expect(output.hookSpecificOutput.additionalContext).toContain('result.md');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('inline: true');
  });

  it('outputs missing bucket for ENOENT job', () => {
    const fixture = createFixture();
    writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now(),
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-missing', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'missing',
    );

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('Status unavailable:');
    expect(output.hookSpecificOutput.additionalContext).toContain('missing');
  });

  it('deletes stale snapshots (>10min old)', () => {
    const fixture = createFixture();
    const staleSnapshotPath = writeSnapshot(
      fixture.snapshotDir,
      {
        capturedAtMs: Date.now() - 15 * 60_000,
        projectRoot: fixture.projectRoot,
        sourceSessionId: 'sess-1',
        jobs: [{ jobId: 'test-job-stale', phase: 'running', provider: 'codex', sessionId: 'sess-1' }],
      },
      'stale',
    );

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(existsSync(staleSnapshotPath)).toBe(false);
  });

  it('exits silently when no snapshots', () => {
    const fixture = createFixture();

    const result = runHook(
      POST_COMPACT_HOOK,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
