import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CORAL_SKILL_VARS_HOOK,
  KB_START_HOOK,
  KB_LOOKUP_REMINDER_HOOK,
  KB_PROMOTE_GATE_HOOK,
  RALPH_LOOP_HOOK,
  SESSION_START_HOOK,
  SUBAGENT_START_HOOK,
  SUBAGENT_TRACK_HOOK,
  cleanupFixtures,
  createFixture,
  expectHookOutput,
  liveWorkSubagentsDir,
  runHook,
  runHookAsync,
  writeInjectBundle,
  expectStopOutput,
  type HookFixture,
  type HookOutput,
  type HookRunResult,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

function initGitRepo(projectRoot: string, remote: string): void {
  execFileSync('git', ['init', '-q'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: projectRoot, stdio: 'ignore' });
}

function coralProjectDir(homeDir: string, source: string): string {
  return join(homeDir, '.coral', 'projects', source.replace(/\//g, '-'));
}

function seedCodebaseMemoryBinary(homeDir: string): void {
  for (const dataDir of ['data', 'data-dev']) {
    const dir = join(homeDir, '.coral', 'gen2', dataDir, 'engines', 'codebase-memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codebase-memory-mcp'), 'binary');
  }
}

describe('session-start.mjs', () => {
  it('outputs the inject bundle with session_id when both are provided', () => {
    const fixture = createFixture();
    const coreFragment = 'Project instructions\nSecond line';
    writeInjectBundle(fixture.pluginRoot, coreFragment);

    const result = runHook(SESSION_START_HOOK, { session_id: 'sess-123' }, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toMatch(
      /^SessionStart:session_id=sess-123\nCurrent host: (claude|codex)\nClaude config dir: .+\n\n/u,
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(coreFragment);
  });

  it('emits a flat, unwrapped payload and "Current host: copilot" under Copilot CLI', () => {
    const fixture = createFixture();
    writeInjectBundle(fixture.pluginRoot, 'Project instructions');

    // Copilot exports COPILOT_PLUGIN_ROOT only when it invokes a plugin hook,
    // and reads per-event fields at the top level — a hookSpecificOutput
    // envelope is silently dropped, so the context would never reach the model.
    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-123' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot, COPILOT_PLUGIN_ROOT: fixture.pluginRoot },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      additionalContext?: string;
      hookSpecificOutput?: unknown;
    };
    expect(output.hookSpecificOutput).toBeUndefined();
    expect(output).not.toHaveProperty('hookEventName');
    expect(output.additionalContext).toMatch(
      /^SessionStart:session_id=sess-123\nCurrent host: copilot\nClaude config dir: .+\n\n/u,
    );
  });

  it('replaces {{CORAL_PROJECTS}} with the source-derived global project dir', () => {
    const fixture = createFixture();
    initGitRepo(fixture.projectRoot, 'https://token@github.com/acme/my.repo.git');
    writeInjectBundle(fixture.pluginRoot, 'Memo dir: {{CORAL_PROJECTS}}/memo');

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

  it('ignores a newly created coral symlink from the anchored .git/info/exclude entry', () => {
    const fixture = createFixture();
    initGitRepo(fixture.projectRoot, 'https://github.com/acme/repo.git');
    writeInjectBundle(fixture.pluginRoot, 'inject content');
    mkdirSync(join(fixture.projectRoot, '.claude'), { recursive: true });

    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-symlink' },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        CORAL_AUTO_SYMLINK: '1',
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    const link = join(fixture.projectRoot, '.claude', 'coral');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(coralProjectDir(fixture.root, 'acme/repo'));
    const excludeLines = readFileSync(join(fixture.projectRoot, '.git', 'info', 'exclude'), 'utf-8').split(/\r?\n/u);
    expect(excludeLines).toContain('/.claude/coral');
    expect(excludeLines).not.toContain('coral');
    expect(existsSync(join(fixture.projectRoot, '.claude', '.gitignore'))).toBe(false);
    expect(existsSync(join(fixture.projectRoot, '.gitignore'))).toBe(false);
  });

  it('rejects a symlinked root gitignore without touching its target', () => {
    const fixture = createFixture();
    initGitRepo(fixture.projectRoot, 'https://github.com/acme/repo.git');
    writeInjectBundle(fixture.pluginRoot, 'inject content');
    mkdirSync(join(fixture.projectRoot, '.claude'), { recursive: true });
    const externalIgnore = join(fixture.root, 'external-root-ignore');
    writeFileSync(externalIgnore, '.claude/coral\nkeep/\n');
    symlinkSync(externalIgnore, join(fixture.projectRoot, '.gitignore'));

    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-unsafe-root-ignore' },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        CORAL_AUTO_SYMLINK: '1',
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(externalIgnore, 'utf-8')).toBe('.claude/coral\nkeep/\n');
    expect(existsSync(join(fixture.projectRoot, '.claude', 'coral'))).toBe(false);
    expect(expectHookOutput(result).hookSpecificOutput.additionalContext).toContain(
      'An affected ignore file is not a readable regular file, the existing .git/info path is a symlink or not a directory, or its real directory lacks owner access.',
    );
  });

  it('rejects oversized root gitignore files before reading or mutating project ignores', () => {
    const fixture = createFixture();
    initGitRepo(fixture.projectRoot, 'https://github.com/acme/repo.git');
    writeInjectBundle(fixture.pluginRoot, 'inject content');
    mkdirSync(join(fixture.projectRoot, '.claude'), { recursive: true });
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61);
    writeFileSync(join(fixture.projectRoot, '.gitignore'), oversized);

    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-oversized-root-ignore' },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        CORAL_AUTO_SYMLINK: '1',
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(join(fixture.projectRoot, '.gitignore'))).toEqual(oversized);
    expect(existsSync(join(fixture.projectRoot, '.claude', 'coral'))).toBe(false);
    expect(
      expectHookOutput(result).hookSpecificOutput.additionalContext,
      'a completed maintenance refusal must reach the session as a reason-specific notice',
    ).toContain("An affected ignore file exceeds Coral's 1 MiB safety limit.");
  });

  it('serializes concurrent retractions without scoped entries or repository-arena residue', async () => {
    const fixture = createFixture();
    initGitRepo(fixture.projectRoot, 'https://github.com/acme/repo.git');
    writeInjectBundle(fixture.pluginRoot, 'inject content');
    mkdirSync(join(fixture.projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(fixture.projectRoot, '.gitignore'), 'dist/\n.claude/coral\ncoverage/\n');
    const env = {
      CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
      CLAUDE_PROJECT_DIR: fixture.projectRoot,
      CORAL_AUTO_SYMLINK: undefined,
      HOME: fixture.root,
    };

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        runHookAsync(SESSION_START_HOOK, { session_id: `sess-concurrent-${index}` }, env),
      ),
    );

    expect(results.every((result) => result.status === 0)).toBe(true);
    expect(readFileSync(join(fixture.projectRoot, '.gitignore'), 'utf-8')).toBe('dist/\ncoverage/\n');
    expect(existsSync(join(fixture.projectRoot, '.claude', '.gitignore'))).toBe(false);
    expect(readdirSync(join(fixture.projectRoot, '.git', 'coral', 'staging', 'project-ignore'))).toEqual([]);
  });
});

describe('kb-start.mjs', () => {
  describe('wake-up payload', () => {
    function seedKbWiki(kbRoot: string, slug: string, updatedAt: string, understanding: string): void {
      const wikiDir = join(kbRoot, 'wiki');
      mkdirSync(wikiDir, { recursive: true });
      writeFileSync(
        join(wikiDir, `${slug}.md`),
        [
          '---',
          'tags: [wake]',
          'createdAt: 2026-05-04T00:00:00.000Z',
          `updatedAt: ${updatedAt}`,
          '---',
          `# ${slug}`,
          '',
          '## Understanding',
          '',
          understanding,
          '',
          '## Knowledge',
          '',
        ].join('\n'),
        'utf-8',
      );
    }

    const PROJECT_SLUG = 'acme-repo';

    it('injects the current-project wiki into additionalContext', () => {
      const fixture = createFixture();
      writeInjectBundle(fixture.pluginRoot, 'inject content');
      initGitRepo(fixture.projectRoot, 'https://token@github.com/acme/repo.git');
      const kbRoot = join(fixture.root, 'kb');
      seedKbWiki(kbRoot, PROJECT_SLUG, '2026-05-04T01:00:00.000Z', 'In-scope understanding.');
      seedKbWiki(kbRoot, 'other-repo', '2026-05-04T02:00:00.000Z', 'Other understanding.');

      const result = runHook(
        KB_START_HOOK,
        { hook_event_name: 'SessionStart', session_id: 'sess-wake' },
        {
          CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
          CLAUDE_PROJECT_DIR: fixture.projectRoot,
          CORAL_KB_PATH: kbRoot,
          HOME: fixture.root,
        },
      );

      const output = expectHookOutput(result);
      expect(output.hookSpecificOutput.additionalContext).toContain(
        `## project wiki: ${PROJECT_SLUG} (2026-05-04T01:00:00.000Z)`,
      );
      expect(output.hookSpecificOutput.additionalContext).toContain('In-scope understanding.');
      expect(output.hookSpecificOutput.additionalContext).not.toContain('## project wiki: other-repo');
      expect(output.hookSpecificOutput.additionalContext).not.toContain('Other understanding.');
    });

    it('returns null when the project wiki has malformed frontmatter (fail-open)', () => {
      const fixture = createFixture();
      writeInjectBundle(fixture.pluginRoot, 'inject content');
      initGitRepo(fixture.projectRoot, 'https://token@github.com/acme/repo.git');
      const kbRoot = join(fixture.root, 'kb');
      const wikiDir = join(kbRoot, 'wiki');
      mkdirSync(wikiDir, { recursive: true });
      writeFileSync(
        join(wikiDir, `${PROJECT_SLUG}.md`),
        '---\nbroken-no-closing-fence\n# Broken\n\n## Understanding\n\nBroken.\n',
        'utf-8',
      );

      const result = runHook(
        KB_START_HOOK,
        { hook_event_name: 'SessionStart', session_id: 'sess-wake' },
        {
          CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
          CLAUDE_PROJECT_DIR: fixture.projectRoot,
          CORAL_KB_PATH: kbRoot,
          HOME: fixture.root,
        },
      );

      expect(result.status).toBe(0);
      const output = expectHookOutput(result);
      expect(output.hookSpecificOutput.additionalContext).not.toContain('## project wiki:');
    });
  });
});

describe('subagent-start.mjs', () => {
  it('outputs the inject bundle with SubagentStart hookEventName', () => {
    const fixture = createFixture();
    writeInjectBundle(fixture.pluginRoot, 'Guidelines for subagent');

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

  it('renders equipped tools when the engine binary is installed', () => {
    const fixture = createFixture();
    seedCodebaseMemoryBinary(fixture.root);
    writeInjectBundle(fixture.pluginRoot, { tools: 'Tools\n\n{{EQUIPPED_TOOLS}}\n\nDone' });

    const result = runHook(
      SUBAGENT_START_HOOK,
      { session_id: 'sess-parent' },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        HOME: fixture.root,
      },
    );

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('- codebase-memory:');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('{{EQUIPPED_TOOLS}}');
  });
});

describe('kb-promote-gate.mjs', () => {
  it('reads memos from the global project dir and blocks stop with memo-review guidance', () => {
    const fixture = createFixture();
    const memoDir = join(coralProjectDir(fixture.root, `local/${basename(fixture.projectRoot)}`), 'memo');
    mkdirSync(memoDir, { recursive: true });
    // Gate threshold is 10.
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
        CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot,
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

  it('arms the session KB flag from a bare PreToolUse skill name (Copilot)', () => {
    const fixture = createFixture();
    // The gate exits early when the project has no memo dir; an empty one keeps
    // the flag path reachable with zero memos.
    mkdirSync(join(coralProjectDir(fixture.root, `local/${basename(fixture.projectRoot)}`), 'memo'), {
      recursive: true,
    });

    // Copilot sends tool_input.skill as the bare "ralph"; matching only the
    // "coral:ralph" form left the Stop-time promotion gate permanently unarmed.
    runHook(
      KB_PROMOTE_GATE_HOOK,
      { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_input: { skill: 'ralph' } },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
        CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot,
        COPILOT_PLUGIN_ROOT: fixture.pluginRoot,
      },
    );

    const result = runHook(
      KB_PROMOTE_GATE_HOOK,
      { hook_event_name: 'Stop', session_id: 'sess-1' },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
        CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot,
        COPILOT_PLUGIN_ROOT: fixture.pluginRoot,
      },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('No memos to process');
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

  it('does not inherit the parent CORAL_KB_PATH in hook tests', () => {
    const fixture = createFixture();
    const fixtureKbDir = join(fixture.root, '.coral', 'kb', 'notes');
    const parentKbDir = join(fixture.root, 'parent-kb', 'notes');
    mkdirSync(fixtureKbDir, { recursive: true });
    mkdirSync(parentKbDir, { recursive: true });
    writeFileSync(join(fixtureKbDir, 'fixture-topic.md'), '# Fixture', 'utf-8');
    writeFileSync(join(parentKbDir, 'parent-leak.md'), '# Parent Leak', 'utf-8');

    const previousKbPath = process.env.CORAL_KB_PATH;
    process.env.CORAL_KB_PATH = join(fixture.root, 'parent-kb');
    try {
      const result = runHook(
        KB_LOOKUP_REMINDER_HOOK,
        { hook_event_name: 'PostToolUseFailure' },
        { HOME: fixture.root },
      );

      expect(result.status).toBe(0);

      const output = expectHookOutput(result);
      expect(output.hookSpecificOutput.additionalContext).toContain('KB topics: fixture');
      expect(output.hookSpecificOutput.additionalContext).not.toContain('parent-leak');
    } finally {
      if (previousKbPath === undefined) {
        delete process.env.CORAL_KB_PATH;
      } else {
        process.env.CORAL_KB_PATH = previousKbPath;
      }
    }
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

  it('injects context for PreToolUse with the bare skill name Copilot sends', () => {
    const fixture = createFixture();

    // Copilot puts the BARE skill name in tool_input.skill ("analyze"), and only
    // falls back to "coral:analyze" when another installed plugin ships the same
    // name — so matching on the `coral:` prefix alone would never fire here.
    const result = runHook(
      CORAL_SKILL_VARS_HOOK,
      {
        hook_event_name: 'PreToolUse',
        tool_input: { skill: 'analyze' },
      },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        COPILOT_PLUGIN_ROOT: fixture.pluginRoot,
      },
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { additionalContext?: string };
    expect(output.additionalContext).toContain('CORAL_PROJECT:');
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

  function startLoop(fixture: HookFixture, sessionId: string, state: Record<string, unknown>): string {
    const env = { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot };
    const started = runHook(
      RALPH_LOOP_HOOK,
      { hook_event_name: 'UserPromptSubmit', user_message: '/ralph go', session_id: sessionId },
      env,
    );
    const statePath = /Ralph loop state file: (\S+\.json)/u.exec(
      (JSON.parse(started.stdout) as HookOutput).hookSpecificOutput.additionalContext,
    )?.[1];
    if (statePath === undefined) throw new Error('the hook did not report a state file path');
    writeFileSync(statePath, JSON.stringify(state));
    return statePath;
  }

  function stop(fixture: HookFixture, sessionId: string, assistantText: string): HookRunResult {
    return runHook(
      RALPH_LOOP_HOOK,
      { hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: assistantText },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot },
    );
  }

  const PLAN_MODE_STATE = {
    prompt: 'implement plans/topic.md — all ACs must pass',
    iteration: 1,
    maxIterations: 0,
    completionPromise: 'TASK COMPLETE',
  };

  it('drives the next plan-mode iteration when the promise has not been made', () => {
    const fixture = createFixture();
    startLoop(fixture, 'ralph-plan-block', PLAN_MODE_STATE);

    const result = stop(fixture, 'ralph-plan-block', 'Finished batch 1. Moving on.');

    const output = expectStopOutput(result);
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('implement plans/topic.md');
    expect(output.systemMessage).toContain('Ralph iteration 2');
  });

  it('ends the loop and clears its state once the promise is made', () => {
    const fixture = createFixture();
    const statePath = startLoop(fixture, 'ralph-plan-done', PLAN_MODE_STATE);

    const result = stop(fixture, 'ralph-plan-done', 'All done. <promise>TASK COMPLETE</promise>');

    expect(result.stdout.trim()).toBe('');
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(statePath.replace(/\.json$/u, '.active'))).toBe(false);
  });

  it('reports a loop whose state disappeared, once, and stays silent for a session that never ran', () => {
    const fixture = createFixture();
    const statePath = startLoop(fixture, 'ralph-lost', PLAN_MODE_STATE);
    rmSync(statePath);

    const reported = stop(fixture, 'ralph-lost', 'I deleted the state file per protocol.');
    const afterwards = stop(fixture, 'ralph-lost', 'Still going.');
    const neverRan = stop(fixture, 'ralph-never-started', 'Unrelated session.');

    expect((JSON.parse(reported.stdout) as { systemMessage?: string }).systemMessage).toContain(
      'Ralph loop state is gone',
    );
    expect(afterwards.stdout.trim()).toBe('');
    expect(neverRan.stdout.trim()).toBe('');
  });
});

describe('subagent-track hook', () => {
  it('creates a marker on SubagentStart and removes it on SubagentStop', () => {
    const fixture = createFixture();
    const sessionId = 'test-session-track-001';
    const agentId = 'agent001';
    const marker = join(liveWorkSubagentsDir(fixture, sessionId), agentId);

    const started = runHook(
      SUBAGENT_TRACK_HOOK,
      { hook_event_name: 'SubagentStart', session_id: sessionId, agent_id: agentId },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );
    expect(started.status).toBe(0);
    expect(existsSync(marker)).toBe(true);

    const stopped = runHook(
      SUBAGENT_TRACK_HOOK,
      { hook_event_name: 'SubagentStop', session_id: sessionId, agent_id: agentId },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );
    expect(stopped.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('ralph-loop hook subagent gate', () => {
  function seedRalphState(snapshotDir: string, sessionId: string): void {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, `ralph-state-${sessionId}.json`),
      JSON.stringify({ prompt: 'keep building', iteration: 1, maxIterations: 0, completionPromise: 'TASK COMPLETE' }),
    );
  }

  it('defers the next iteration while a subagent is live', () => {
    const fixture = createFixture();
    const sessionId = 'test-session-gate-001';
    const transcriptRoot = join(fixture.root, 'projects', 'p');
    const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`);
    seedRalphState(fixture.snapshotDir, sessionId);
    const liveSubagents = liveWorkSubagentsDir(fixture, sessionId);
    mkdirSync(liveSubagents, { recursive: true });
    writeFileSync(join(liveSubagents, 'agentX'), '');
    const subagentsDir = join(transcriptRoot, sessionId, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, 'agent-agentX.jsonl'), '{}');

    const result = runHook(
      RALPH_LOOP_HOOK,
      {
        hook_event_name: 'Stop',
        session_id: sessionId,
        transcript_path: transcriptPath,
        last_assistant_message: 'still working',
      },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    const state = JSON.parse(readFileSync(join(fixture.snapshotDir, `ralph-state-${sessionId}.json`), 'utf-8'));
    expect(state.iteration).toBe(1);
  });

  it('drives the next iteration when no subagent is live', () => {
    const fixture = createFixture();
    const sessionId = 'test-session-gate-002';
    const transcriptPath = join(fixture.root, 'projects', 'p', `${sessionId}.jsonl`);
    seedRalphState(fixture.snapshotDir, sessionId);

    const result = runHook(
      RALPH_LOOP_HOOK,
      {
        hook_event_name: 'Stop',
        session_id: sessionId,
        transcript_path: transcriptPath,
        last_assistant_message: 'still working',
      },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );

    expect(result.status).toBe(0);
    expect(expectStopOutput(result).decision).toBe('block');
    const state = JSON.parse(readFileSync(join(fixture.snapshotDir, `ralph-state-${sessionId}.json`), 'utf-8'));
    expect(state.iteration).toBe(2);
  });
});

describe('kb-promote-gate hook subagent gate', () => {
  it('defers the memo-promotion block while a subagent is live, then fires once gone', () => {
    const fixture = createFixture();
    const sessionId = 'sess-kb-gate';
    const memoDir = join(coralProjectDir(fixture.root, `local/${basename(fixture.projectRoot)}`), 'memo');
    mkdirSync(memoDir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(memoDir, `20260321-note-${i}.md`), 'memo', 'utf-8');
    }

    const liveSubagents = liveWorkSubagentsDir(fixture, sessionId);
    mkdirSync(liveSubagents, { recursive: true });
    writeFileSync(join(liveSubagents, 'agentK'), '');
    const transcriptRoot = join(fixture.root, 'projects', 'p');
    const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`);
    const subagentsDir = join(transcriptRoot, sessionId, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, 'agent-agentK.jsonl'), '{}');

    const deferred = runHook(
      KB_PROMOTE_GATE_HOOK,
      { hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcriptPath },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
        TMPDIR: fixture.tmpRoot,
        CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot,
      },
    );
    expect(deferred.status).toBe(0);
    expect(deferred.stdout.trim()).toBe('');

    // a session with no live subagent still gets the block (memos are owner-less)
    const fired = runHook(
      KB_PROMOTE_GATE_HOOK,
      { hook_event_name: 'Stop', session_id: 'sess-kb-none', transcript_path: transcriptPath },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        HOME: fixture.root,
        TMPDIR: fixture.tmpRoot,
        CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot,
      },
    );
    expect(expectStopOutput(fired).decision).toBe('block');
  });
});
