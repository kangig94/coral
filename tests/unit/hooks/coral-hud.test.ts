import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// prettier-ignore
// @ts-expect-error - statusline hooks are executable .mjs files without TS declarations.
import { codexCacheKey, coralBackendInfoPath, extractUserText, readSettingsEnvValue, stripControlSequences, hudCacheFile, hudFetchLockPath, shouldUseClaudeKeychain } from '../../../clients/skills/statusline/coral-hud.mjs';

describe('coral-hud account isolation', () => {
  it('uses a redacted distinct cache slot for each CODEX_HOME', () => {
    const accountA = codexCacheKey('/accounts/codex-a');
    const accountB = codexCacheKey('/accounts/codex-b');

    expect(accountA).toMatch(/^codex-[0-9a-f]{12}$/u);
    expect(accountA).not.toContain('/accounts');
    expect(accountA).not.toBe(accountB);
    expect(codexCacheKey('/accounts/../accounts/codex-a')).toBe(accountA);
  });

  it('uses separate cache files and locks while backend discovery stays account-neutral', () => {
    const cacheDir = '/accounts/claude/hud';
    const accountA = codexCacheKey('/accounts/codex-a');
    const accountB = codexCacheKey('/accounts/codex-b');

    expect(hudCacheFile(cacheDir, accountA)).not.toBe(hudCacheFile(cacheDir, accountB));
    expect(hudFetchLockPath(cacheDir, accountA)).not.toBe(hudFetchLockPath(cacheDir, accountB));
    expect(coralBackendInfoPath('/home/operator')).toBe('/home/operator/.coral/gen2/run/coordinator.json');
  });

  it('allows macOS Keychain only for ambient Claude', () => {
    expect(shouldUseClaudeKeychain(false, 'darwin')).toBe(true);
    expect(shouldUseClaudeKeychain(true, 'darwin')).toBe(false);
    expect(shouldUseClaudeKeychain(false, 'linux')).toBe(false);
  });
});

describe('coral-hud temporary files', () => {
  it('reclaims only expired HUD and Codex credential temps', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-hud-temp-'));
    const cfg = join(root, 'cfg');
    const hud = join(cfg, 'hud');
    const codex = join(root, 'codex');
    const oldHudTemp = join(hud, '.coral-cache.json.tmp-123');
    const oldCodexTemp = join(codex, 'auth.json.tmp-123');
    const freshHudTemp = join(hud, '.coral-git-cache.json.tmp-456');
    const unrelatedTemp = join(hud, '.coral-unrelated.json.tmp-123');
    try {
      mkdirSync(hud, { recursive: true });
      mkdirSync(codex, { recursive: true });
      for (const path of [oldHudTemp, oldCodexTemp, freshHudTemp, unrelatedTemp]) writeFileSync(path, 'temp');
      const old = new Date(Date.now() - 6 * 60 * 1000);
      utimesSync(oldHudTemp, old, old);
      utimesSync(oldCodexTemp, old, old);
      utimesSync(unrelatedTemp, old, old);

      spawnSync(process.execPath, [join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')], {
        input: JSON.stringify({ cwd: root, session_id: 'temps', model: { display_name: 'O' } }),
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codex },
        encoding: 'utf-8',
      });

      expect(existsSync(oldHudTemp)).toBe(false);
      expect(existsSync(oldCodexTemp)).toBe(false);
      expect(existsSync(freshHudTemp)).toBe(true);
      expect(existsSync(unrelatedTemp)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('coral-hud terminal-safe rendering', () => {
  const hyperlink = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

  it('removes control bytes from transcript text before it reaches the terminal', () => {
    expect(stripControlSequences('hi \x1b[31mred\x1b[0m there')).toBe('hi red there');
    expect(stripControlSequences(`click ${hyperlink('http://evil', 'here')}`)).toBe('click here');
    expect(stripControlSequences('line\u0007bell')).toBe('line bell');
    expect(stripControlSequences('line\u009b2Jred')).toBe('line 2Jred');
  });

  it('sanitizes on the path a pasted prompt actually travels, not only in the helper', () => {
    // A prompt is echoed on every later render of the session, so an escape that survives extraction
    // is replayed into the terminal each time.
    expect(extractUserText('deploy \x1b[2Jnow')).toBe('deploy now');
    expect(extractUserText('<command-name>/ship</command-name><command-args>\x1b[31mprod</command-args>')).toBe(
      '/ship prod',
    );
  });
});

describe('coral-hud reef rendering', () => {
  it('rejects a control byte in the URL before putting it in an OSC hyperlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-hud-reef-'));
    const cfg = join(root, 'cfg');
    const home = join(root, 'home');
    const preload = join(root, 'fetch.cjs');
    try {
      mkdirSync(join(home, '.coral', 'gen2', 'run'), { recursive: true });
      mkdirSync(join(cfg, 'coral'), { recursive: true });
      writeFileSync(
        join(home, '.coral', 'gen2', 'run', 'coordinator.json'),
        JSON.stringify({ pid: process.pid, port: 41237, bootToken: 'test' }),
      );
      writeFileSync(join(cfg, 'coral', 'reef.json'), JSON.stringify({ url: 'http://127.0.0.1:41237/\x1b]8;;pwned' }));
      writeFileSync(
        preload,
        'global.fetch = async () => ({ ok: true, json: async () => ({ active: 0, queueDepth: 0, liveDiscuss: 0 }) });\n',
      );

      const result = spawnSync(
        process.execPath,
        ['--require', preload, join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')],
        {
          input: JSON.stringify({ cwd: root, session_id: 'reef', model: { display_name: 'O' } }),
          env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: join(root, 'codex'), HOME: home },
          encoding: 'utf-8',
        },
      );

      expect(result.stdout ?? '').not.toContain('reef');
      expect(result.stdout ?? '').not.toContain('\x1b]8;;pwned');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('coral-hud transcript rendering end to end', () => {
  function renderWithTranscript(sessionId: string, lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'coral-hud-'));
    const transcript = join(dir, 'session.jsonl');
    writeFileSync(transcript, lines.join('\n'));
    const result = spawnSync(process.execPath, [join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')], {
      input: JSON.stringify({
        cwd: dir,
        session_id: sessionId,
        transcript_path: transcript,
        model: { display_name: 'O' },
      }),
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'cfg'), HOME: join(dir, 'home') },
      encoding: 'utf-8',
    });
    rmSync(dir, { recursive: true, force: true });
    return result.stdout ?? '';
  }

  // Each extractor owns a different slot and one hides the others — a running agent outranks the
  // activity name — so a single transcript cannot prove all three are sanitized.
  const ESCAPE = '\u001b]0;pwned\u0007\u001b[2J';

  it('removes C1 controls from a pasted prompt before the statusline prints it', () => {
    const printed = renderWithTranscript('c1-prompt', [
      JSON.stringify({ message: { content: '<command-message>deploy\u009b2Jnow</command-message>' } }),
    ]);

    expect(printed).toContain('deploy 2Jnow');
    expect(printed).not.toContain('\u009b');
  });

  it('sanitizes the slash-command name it prints as activity', () => {
    const printed = renderWithTranscript('esc-cmd', [
      JSON.stringify({ message: { content: `<command-message>${ESCAPE}deploy</command-message>` } }),
    ]);

    expect(printed).toContain('deploy');
    expect(printed).not.toContain('\u001b]');
    expect(printed).not.toContain('\u001b[2J');
  });

  it('sanitizes the skill name taken from a Skill tool call', () => {
    const printed = renderWithTranscript('esc-skill', [
      JSON.stringify({
        message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: `${ESCAPE}coral:ralph` } }] },
      }),
    ]);

    expect(printed).toContain('coral:ralph');
    expect(printed).not.toContain('\u001b]');
    expect(printed).not.toContain('\u001b[2J');
  });

  it('sanitizes the subagent type it prints as a running-agent count', () => {
    const printed = renderWithTranscript('esc-agent', [
      JSON.stringify({
        message: { content: [{ type: 'tool_use', name: 'Task', id: 't1', input: { subagent_type: `ev${ESCAPE}il` } }] },
        timestamp: new Date().toISOString(),
      }),
    ]);

    expect(printed).not.toContain('\u001b]');
    expect(printed).not.toContain('\u001b[2J');
  });
});

describe('coral-hud repository-supplied settings', () => {
  it('strips and bounds a value a cloned repository chose', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coral-hud-set-'));
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ env: { CORAL_CODEX_MODEL: '\u001b]0;pwned\u0007' + 'x'.repeat(200) } }));

    const value = readSettingsEnvValue(settings, 'CORAL_CODEX_MODEL') as string;

    expect(value).not.toContain('\u001b');
    expect(value.length).toBeLessThanOrEqual(32);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('coral-hud git cache under concurrent repositories', () => {
  function renderIn(cfgDir: string, cwd: string): void {
    spawnSync(process.execPath, [join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')], {
      input: JSON.stringify({ cwd, session_id: 'gc', model: { display_name: 'O' } }),
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir },
      encoding: 'utf-8',
    });
  }

  it('keeps another repository fenced while a healthy one records its branch', () => {
    // A back-off is the only containment a repository on a stalled mount has, and a whole-map write
    // from an unrelated repository could carry away the entry holding it.
    const root = mkdtempSync(join(tmpdir(), 'coral-hud-gc-'));
    const cfg = join(root, 'cfg');
    const cacheFile = join(cfg, 'hud', '.coral-git-cache.json');
    renderIn(cfg, process.cwd());

    const fencedUntil = Date.now() + 600_000;
    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, Record<string, unknown>>;
    // Expire the healthy repository so the next render actually probes and rewrites the map.
    for (const entry of Object.values(cache)) entry.ts = 0;
    cache.stalledrepokey = { ts: 0, value: { branch: 'main', dirty: false }, backoffUntil: fencedUntil };
    writeFileSync(cacheFile, JSON.stringify(cache));

    renderIn(cfg, process.cwd());

    const after = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, { backoffUntil: number }>;
    expect(after.stalledrepokey?.backoffUntil, 'the fence must survive an unrelated write').toBe(fencedUntil);
    rmSync(root, { recursive: true, force: true });
  });
});
