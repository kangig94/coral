import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CORAL_SKILL_VARS_HOOK,
  HOOKS_JSON_PATH,
  HUD_AUTO_UPDATE_HOOK,
  KB_LOOKUP_REMINDER_HOOK,
  KB_MEMO_REMINDER_HOOK,
  KB_PROMOTE_GATE_HOOK,
  PRE_COMPACT_HOOK,
  RALPH_LOOP_HOOK,
  SESSION_START_HOOK,
  SUBAGENT_START_HOOK,
  cleanupFixtures,
  createFixture,
  expectHookOutput,
  expectStopOutput,
  parseHookOutput,
  runHook,
  writeInjectMd,
} from './_helpers.js';
import type { JobStatus } from './_helpers.js';

afterEach(cleanupFixtures);

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

    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-1' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain(
      `KB: node "${join(fixture.pluginRoot, 'bridge', 'coral-cli.cjs')}" kb principles`,
    );
  });

  it('exits silently when session_id is missing (CORAL_CHILD guard would also catch this)', () => {
    const fixture = createFixture();
    writeInjectMd(fixture.pluginRoot, 'Only CLAUDE content');

    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    expect(result.status).toBe(0);
    expect(parseHookOutput(result.stdout)).toBeNull();
  });

  it('exits cleanly when CLAUDE_PLUGIN_ROOT unset', () => {
    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: undefined });

    expect(result.status).toBe(0);
    expect(parseHookOutput(result.stdout)).toBeNull();
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

  it('keeps SESSION_ID_ONLY blocks and substitutes the parent session_id', () => {
    const fixture = createFixture();
    writeInjectMd(
      fixture.pluginRoot,
      'visible\n<!-- SESSION_ID_ONLY:BEGIN -->\nowner={{SESSION_ID}}\n<!-- SESSION_ID_ONLY:END -->\nafter',
    );

    const result = runHook(
      SUBAGENT_START_HOOK,
      { session_id: 'sess-parent' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('visible');
    expect(output.hookSpecificOutput.additionalContext).toContain('owner=sess-parent');
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

describe('coral-skill-vars hook', () => {
  it('injects CORAL_PROJECT and CORAL_METHODS for matching UserPromptSubmit', () => {
    const fixture = createFixture();

    const result = runHook(
      CORAL_SKILL_VARS_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: '/coral:plan do something',
      },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
      },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as HookOutput;
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('CORAL_PROJECT:');
    expect(output.hookSpecificOutput.additionalContext).toContain('CORAL_METHODS:');
    expect(output.hookSpecificOutput.additionalContext).toContain(join(fixture.pluginRoot, 'methods'));
  });

  it('injects context for PreToolUse with coral: skill prefix', () => {
    const fixture = createFixture();

    const result = runHook(
      CORAL_SKILL_VARS_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_input: { skill: 'coral:analyze' },
      },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
      },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as HookOutput;
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('CORAL_PROJECT:');
  });

  it('exits silently for non-matching messages', () => {
    const fixture = createFixture();

    const result = runHook(
      CORAL_SKILL_VARS_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: 'just a regular message',
      },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits silently when CLAUDE_PLUGIN_ROOT is missing', () => {
    const fixture = createFixture();

    const result = runHook(
      CORAL_SKILL_VARS_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: '/coral:plan do something',
      },
      {
        CLAUDE_PLUGIN_ROOT: undefined,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits silently when flavor mismatch (CORAL_FLAVOR=dev vs prod manifest)', () => {
    const fixture = createFixture();

    const result = runHook(
      CORAL_SKILL_VARS_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: '/coral:plan do something',
      },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        CORAL_FLAVOR: 'dev',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('hud-auto-update hook', () => {
  it('exits silently when CLAUDE_PLUGIN_ROOT is missing', () => {
    const result = runHook(
      HUD_AUTO_UPDATE_HOOK,
      { hook_event_name: 'SessionStart' },
      { CLAUDE_PLUGIN_ROOT: undefined },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits silently when flavor mismatch (CORAL_FLAVOR=dev vs prod manifest)', () => {
    const fixture = createFixture();

    const result = runHook(
      HUD_AUTO_UPDATE_HOOK,
      { hook_event_name: 'SessionStart' },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CORAL_FLAVOR: 'dev',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits silently when no hud file is installed', () => {
    const fixture = createFixture();

    const result = runHook(
      HUD_AUTO_UPDATE_HOOK,
      { hook_event_name: 'SessionStart' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('ralph-loop hook', () => {
  it('injects ralph state context for matching UserPromptSubmit', () => {
    const fixture = createFixture();

    const result = runHook(
      RALPH_LOOP_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: '/ralph build the feature',
        session_id: 'test-session-ralph-001',
      },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as HookOutput;
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('ralph-state-');
  });

  it('injects context for PreToolUse with coral:ralph skill', () => {
    const fixture = createFixture();

    const result = runHook(
      RALPH_LOOP_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_input: { skill: 'coral:ralph' },
        session_id: 'test-session-ralph-002',
      },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as HookOutput;
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('ralph-state-');
  });

  it('exits silently for non-matching messages', () => {
    const fixture = createFixture();

    const result = runHook(
      RALPH_LOOP_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: 'just a normal message',
        session_id: 'test-session-ralph-003',
      },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits silently without session_id', () => {
    const result = runHook(
      RALPH_LOOP_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: '/ralph do something',
      },
      {},
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits silently when flavor mismatch (CORAL_FLAVOR=dev vs prod manifest)', () => {
    const fixture = createFixture();

    const result = runHook(
      RALPH_LOOP_HOOK,
      {
        hook_event_name: 'UserPromptSubmit',
        user_message: '/ralph do something',
        session_id: 'test-session-ralph-004',
      },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        CORAL_FLAVOR: 'dev',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
