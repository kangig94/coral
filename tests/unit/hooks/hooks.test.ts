import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_HOOKS_JSON_PATH,
  CODEX_HOOKS_JSON_PATH,
  CORAL_SKILL_VARS_HOOK,
  HUD_AUTO_UPDATE_HOOK,
  KB_LOOKUP_REMINDER_HOOK,
  KB_MEMO_REMINDER_HOOK,
  KB_PROMOTE_GATE_HOOK,
  PRE_COMPACT_HOOK,
  RALPH_LOOP_HOOK,
  SESSION_START_HOOK,
  SUBAGENT_START_HOOK,
  SUBAGENT_TRACK_HOOK,
  cleanupFixtures,
  createFixture,
  expectHookOutput,
  expectStopOutput,
  liveWorkSubagentsDir,
  parseHookOutput,
  runHook,
  writeInjectBundle,
  type HookOutput,
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
    const dir = join(homeDir, '.coral', dataDir, 'engines', 'codebase-memory');
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

  it('replaces {{CORAL_CLI}} with the shell-quoted coral-cli bridge path', () => {
    const fixture = createFixture();
    writeInjectBundle(fixture.pluginRoot, 'KB: {{CORAL_CLI}} kb principles');

    const result = runHook(SESSION_START_HOOK, { session_id: 'sess-1' }, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    expect(result.status).toBe(0);

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain(
      `KB: node "${join(fixture.pluginRoot, 'bridge', 'coral-cli.cjs')}" kb principles`,
    );
  });

  it('exits silently when session_id is missing (CORAL_CHILD guard would also catch this)', () => {
    const fixture = createFixture();
    writeInjectBundle(fixture.pluginRoot, 'Only CLAUDE content');

    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    expect(result.status).toBe(0);
    expect(parseHookOutput(result.stdout)).toBeNull();
  });

  it('exits cleanly when CLAUDE_PLUGIN_ROOT unset', () => {
    const result = runHook(SESSION_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: undefined });

    expect(result.status).toBe(0);
    expect(parseHookOutput(result.stdout)).toBeNull();
  });

  it('includes the orchestrator fragment for top-level sessions', () => {
    const fixture = createFixture();
    writeInjectBundle(fixture.pluginRoot, { core: 'base\nrest', kbOrchestrator: 'owner instruction' });

    const result = runHook(
      SESSION_START_HOOK,
      { session_id: 'sess-owner' },
      { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toContain('owner instruction');
  });

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

    // For projectDir = fixture.projectRoot with origin acme/repo, the
    // current-project slug (dash form) is 'acme-repo'.
    const PROJECT_SLUG = 'acme-repo';

    it('injects the current-project wiki into additionalContext', () => {
      const fixture = createFixture();
      writeInjectBundle(fixture.pluginRoot, 'inject content');
      initGitRepo(fixture.projectRoot, 'https://token@github.com/acme/repo.git');
      const kbRoot = join(fixture.root, 'kb');
      seedKbWiki(kbRoot, PROJECT_SLUG, '2026-05-04T01:00:00.000Z', 'In-scope understanding.');
      seedKbWiki(kbRoot, 'other-repo', '2026-05-04T02:00:00.000Z', 'Other understanding.');

      const result = runHook(
        SESSION_START_HOOK,
        { session_id: 'sess-wake' },
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

    it('omits the wake-up block entirely when the project wiki is absent', () => {
      const fixture = createFixture();
      writeInjectBundle(fixture.pluginRoot, 'inject content');
      initGitRepo(fixture.projectRoot, 'https://token@github.com/acme/repo.git');
      const kbRoot = join(fixture.root, 'kb');
      seedKbWiki(kbRoot, 'foreign', '2026-05-04T01:00:00.000Z', 'Foreign understanding.');

      const result = runHook(
        SESSION_START_HOOK,
        { session_id: 'sess-wake' },
        {
          CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
          CLAUDE_PROJECT_DIR: fixture.projectRoot,
          CORAL_KB_PATH: kbRoot,
          HOME: fixture.root,
        },
      );

      const output = expectHookOutput(result);
      expect(output.hookSpecificOutput.additionalContext).not.toContain('## project wiki: foreign');
      expect(output.hookSpecificOutput.additionalContext).not.toContain('Foreign understanding.');
      expect(output.hookSpecificOutput.additionalContext).not.toMatch(/inject content[\s\S]*\n## project wiki: /u);
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
        SESSION_START_HOOK,
        { session_id: 'sess-wake' },
        {
          CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
          CLAUDE_PROJECT_DIR: fixture.projectRoot,
          CORAL_KB_PATH: kbRoot,
          HOME: fixture.root,
        },
      );

      expect(result.status).toBe(0);
      const output = expectHookOutput(result);
      // Malformed file produces no wake-up block; identity absent → no "## " heading appears.
      expect(output.hookSpecificOutput.additionalContext).not.toMatch(/inject content[\s\S]*\n## /u);
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

  it('includes session guidance and substitutes the parent session_id', () => {
    const fixture = createFixture();
    writeInjectBundle(fixture.pluginRoot, { core: 'visible\nafter', kbSession: 'owner={{SESSION_ID}}' });

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

  it('omits the orchestrator fragment', () => {
    const fixture = createFixture();
    writeInjectBundle(fixture.pluginRoot, { core: 'base\nrest', kbOrchestrator: 'propagate owner' });

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
    writeInjectBundle(fixture.pluginRoot, 'CLI: {{CORAL_CLI}}');

    const result = runHook(SUBAGENT_START_HOOK, {}, { CLAUDE_PLUGIN_ROOT: fixture.pluginRoot });

    const output = expectHookOutput(result);
    expect(output.hookSpecificOutput.additionalContext).toBe(
      `CLI: node "${join(fixture.pluginRoot, 'bridge', 'coral-cli.cjs')}"`,
    );
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
    expect(output.hookSpecificOutput.additionalContext).toContain(
      '⚠ Equipped tools are capabilities the user explicitly installed via /equip',
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'MUST use every applicable equipped tool as the highest-priority first pass',
    );
    expect(output.hookSpecificOutput.additionalContext).toContain('- codebase-memory:');
    expect(output.hookSpecificOutput.additionalContext).toContain('Use trace_path to inspect callers');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('{{EQUIPPED_TOOLS}}');
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

  it('no-ops when CORAL_KB_ENABLE=0', () => {
    const fixture = createFixture();
    const kbDir = join(fixture.root, '.coral', 'kb', 'notes');
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, 'hooks-paths.md'), '# Hooks', 'utf-8');

    const result = runHook(
      KB_LOOKUP_REMINDER_HOOK,
      { hook_event_name: 'PostToolUseFailure' },
      { HOME: fixture.root, CORAL_KB_ENABLE: '0' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});

type HooksFile = {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
};

describe('claude.json', () => {
  it('does not reference migrate-coral-dir.mjs', () => {
    expect(readFileSync(CLAUDE_HOOKS_JSON_PATH, 'utf-8')).not.toContain('migrate-coral-dir.mjs');
  });

  it('SessionStart matcher "*" array has 2 entries: session-start (10s) then hud-auto-update (3s)', () => {
    const hooksJson = JSON.parse(readFileSync(CLAUDE_HOOKS_JSON_PATH, 'utf-8')) as HooksFile;
    const wildcardEntry = hooksJson.hooks.SessionStart.find((entry) => entry.matcher === '*');
    expect(wildcardEntry).toBeDefined();
    expect(wildcardEntry!.hooks).toHaveLength(2);
    expect(wildcardEntry!.hooks[0].command).toContain('session-start.mjs');
    expect(wildcardEntry!.hooks[0].timeout).toBe(10);
    expect(wildcardEntry!.hooks[1].command).toContain('hud-auto-update.mjs');
    expect(wildcardEntry!.hooks[1].timeout).toBe(3);
    expect(JSON.stringify(wildcardEntry)).not.toContain('backend-warm-start.mjs');
  });
});

describe('codex.json', () => {
  it('does not reference migrate-coral-dir.mjs', () => {
    expect(readFileSync(CODEX_HOOKS_JSON_PATH, 'utf-8')).not.toContain('migrate-coral-dir.mjs');
  });

  it('omits the Claude-only hooks (hud-auto-update, subagent-start, subagent-track, monitor-track)', () => {
    const raw = readFileSync(CODEX_HOOKS_JSON_PATH, 'utf-8');
    for (const script of ['hud-auto-update.mjs', 'subagent-start.mjs', 'subagent-track.mjs', 'monitor-track.mjs']) {
      expect(raw).not.toContain(script);
    }
    const hooksJson = JSON.parse(raw) as HooksFile;
    // Subagent events are dropped entirely (their only hooks were the excluded scripts).
    expect(hooksJson.hooks.SubagentStart).toBeUndefined();
    expect(hooksJson.hooks.SubagentStop).toBeUndefined();
    // SessionStart "*" keeps only session-start (hud-auto-update removed).
    const wildcard = hooksJson.hooks.SessionStart.find((entry) => entry.matcher === '*');
    expect(wildcard!.hooks).toHaveLength(1);
    expect(wildcard!.hooks[0].command).toContain('session-start.mjs');
    // PreToolUse loses only the Monitor matcher; Skill and Bash remain.
    const preMatchers = hooksJson.hooks.PreToolUse.map((entry) => entry.matcher);
    expect(preMatchers).not.toContain('Monitor');
    expect(preMatchers).toEqual(expect.arrayContaining(['Skill', 'Bash']));
  });
});

describe('pre-compact.mjs', () => {
  function seedStore(homeDir: string, projectRoot: string, fingerprint: string): void {
    const storeDir = join(homeDir, '.coral', 'data', 'store');
    mkdirSync(storeDir, { recursive: true });
    const db = new DatabaseSync(join(storeDir, 'store.db'));
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE projection_jobs (
          job_id TEXT PRIMARY KEY,
          phase TEXT NOT NULL,
          project_root TEXT NOT NULL,
          last_seq INTEGER NOT NULL
        );
      `);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('store_format_fingerprint', fingerprint);
      db.prepare('INSERT INTO projection_jobs (job_id, phase, project_root, last_seq) VALUES (?, ?, ?, ?)').run(
        'job-live',
        'running',
        projectRoot,
        1,
      );
    } finally {
      db.close();
    }
    writeFileSync(join(storeDir, 'store.db.format'), `${fingerprint}\n`, 'utf8');
  }

  function seedPluginManifest(pluginRoot: string, fingerprint: string): string {
    cpSync(join(process.cwd(), 'clients', 'hooks'), join(pluginRoot, 'hooks'), { recursive: true });
    const bridgeDir = join(pluginRoot, 'bridge');
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(
      join(bridgeDir, 'manifest.json'),
      JSON.stringify({ bundleHash: 'hook-test', flavor: 'prod', storeFormatFingerprint: fingerprint }),
      'utf8',
    );
    return join(pluginRoot, 'hooks', 'pre-compact.mjs');
  }

  it('exits 0, emits a no-op log line, and does not write snapshots', () => {
    const fixture = createFixture();

    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-1', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(fixture.snapshotDir)).toBe(false);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'no relevant jobs to snapshot',
    });
  });

  it('remains fail-open with no jobs directory', () => {
    const fixture = createFixture();

    const result = runHook(
      PRE_COMPACT_HOOK,
      { session_id: 'sess-3', cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(fixture.snapshotDir)).toBe(false);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'no relevant jobs to snapshot',
    });
  });

  it('does not read a projection from a mismatched store format', () => {
    const fixture = createFixture();
    const hook = seedPluginManifest(
      fixture.pluginRoot,
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    );
    seedStore(
      fixture.root,
      fixture.projectRoot,
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    );

    const result = runHook(
      hook,
      { session_id: 'sess-mismatch', cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.snapshotDir, 'hooks'))).toBe(false);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'compact snapshot skipped',
      reason: 'store format sidecar does not match the installed plugin',
    });
  });

  it('validates the executing hook manifest before opening or touching SQLite siblings', () => {
    const fixture = createFixture();
    const hooksRoot = join(fixture.pluginRoot, 'hooks');
    cpSync(join(process.cwd(), 'clients', 'hooks'), hooksRoot, { recursive: true });
    const fingerprint = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    seedStore(fixture.root, fixture.projectRoot, fingerprint);
    const shmPath = join(fixture.root, '.coral', 'data', 'store', 'store.db-shm');
    writeFileSync(shmPath, 'untouched-shm', 'utf8');
    const before = { bytes: readFileSync(shmPath), mtimeMs: statSync(shmPath).mtimeMs };

    const result = runHook(
      join(hooksRoot, 'pre-compact.mjs'),
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      message: 'compact snapshot skipped',
      reason: 'installed plugin manifest has no valid store format fingerprint',
    });
    expect(readFileSync(shmPath)).toEqual(before.bytes);
    expect(statSync(shmPath).mtimeMs).toBe(before.mtimeMs);
  });

  it('uses the executing hook manifest rather than ambient CLAUDE_PLUGIN_ROOT', () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:4444444444444444444444444444444444444444444444444444444444444444';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    seedStore(fixture.root, fixture.projectRoot, fingerprint);
    const ambientRoot = join(fixture.root, 'ambient-plugin');
    seedPluginManifest(ambientRoot, 'sha256:5555555555555555555555555555555555555555555555555555555555555555');

    const result = runHook(
      hook,
      { cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: ambientRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      message: 'captured job snapshot',
      count: 1,
    });
  });

  it('reads projections only when the installed bridge manifest matches the store format', () => {
    const fixture = createFixture();
    const fingerprint = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    const hook = seedPluginManifest(fixture.pluginRoot, fingerprint);
    seedStore(fixture.root, fixture.projectRoot, fingerprint);

    const result = runHook(
      hook,
      { session_id: 'sess-current', cwd: fixture.projectRoot },
      {
        CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        CLAUDE_PROJECT_DIR: fixture.projectRoot,
        TMPDIR: fixture.tmpRoot,
        HOME: fixture.root,
      },
    );

    expect(result.status).toBe(0);
    const snapshotDir = join(fixture.snapshotDir, 'hooks');
    expect(readdirSync(snapshotDir)).toHaveLength(1);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({
      hook: 'pre-compact',
      message: 'captured job snapshot',
      count: 1,
    });
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

  it('exits silently without agent_id', () => {
    const fixture = createFixture();
    const result = runHook(
      SUBAGENT_TRACK_HOOK,
      { hook_event_name: 'SubagentStart', session_id: 'test-session-track-002' },
      { CLAUDE_PROJECT_DIR: fixture.projectRoot, TMPDIR: fixture.tmpRoot, CORAL_WORK_ROOT_OVERRIDE: fixture.workRoot },
    );
    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.workRoot, 'coral-work'))).toBe(false);
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
    expect(result.stdout.trim()).toBe(''); // deferred: no block emitted
    const state = JSON.parse(readFileSync(join(fixture.snapshotDir, `ralph-state-${sessionId}.json`), 'utf-8'));
    expect(state.iteration).toBe(1); // iteration not advanced
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
    expect(state.iteration).toBe(2); // iteration advanced
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

    // live subagent marker + fresh transcript for the gated session
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
    expect(deferred.stdout.trim()).toBe(''); // deferred: no block

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
