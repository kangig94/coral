import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SESSION_START_HOOK = join(process.cwd(), 'hooks', 'session-start.mjs');
const SUBAGENT_START_HOOK = join(process.cwd(), 'hooks', 'subagent-start.mjs');
const KB_MEMO_REMINDER_HOOK = join(process.cwd(), 'hooks', 'kb-memo-reminder.mjs');
const KB_PROMOTE_GATE_HOOK = join(process.cwd(), 'hooks', 'kb-promote-gate.mjs');
const KB_LOOKUP_REMINDER_HOOK = join(process.cwd(), 'hooks', 'kb-lookup-reminder.mjs');
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

function runHook(
  hookPath: string,
  stdinJson: object,
  envOverrides: Record<string, string | undefined> = {},
): HookRunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };

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
    expect(output.hookSpecificOutput.additionalContext).toContain('Call wait({ jobs: [');
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
    expect(output.hookSpecificOutput.additionalContext).toContain('wait({ jobs: [');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Read result.content if present, otherwise Read(result.path) for the full artifact.',
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
