import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// prettier-ignore
// @ts-expect-error - statusline hooks are executable .mjs files without TS declarations.
import { codexCacheKey, composeCoralThirdLine, coralBackendInfoPath, extractUserText, formatGitSegment, holdIsLive, probeAnswered, readSettingsEnvValue, renderActivityStr, stripControlSequences, hudCacheFile, hudFetchLockPath, parseGitStatus, renderTextProjectionIndicator, shouldUseClaudeKeychain } from '../../../clients/skills/statusline/coral-hud.mjs';

function visible(value: string): string {
  // eslint-disable-next-line no-control-regex -- Strips ANSI SGR escape sequences from hook output.
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('coral-hud text projection indicator', () => {
  it('hides the indicator when idle', () => {
    expect(renderTextProjectionIndicator('idle')).toBeNull();
    expect(renderTextProjectionIndicator(undefined)).toBeNull();
  });

  it('renders coarse fetch and reindex labels', () => {
    expect(visible(renderTextProjectionIndicator('fetching'))).toBe('fetching');
    expect(visible(renderTextProjectionIndicator('reindexing'))).toBe('reindexing');
  });

  it('right-aligns the active indicator on the Coral line', () => {
    const indicator = renderTextProjectionIndicator('reindexing');
    const rendered = composeCoralThirdLine('coral gear:1', indicator, 'last user input', 32);

    expect(visible(rendered)).toBe('coral gear:1          reindexing');
    expect(visible(rendered)).not.toContain('last user input');
  });
});

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

  it('constrains uninstall cleanup to account-scoped cache and lock basenames', () => {
    const skill = readFileSync('clients/skills/statusline/SKILL.md', 'utf-8');

    expect(skill).toContain('^\\.coral-codex-[0-9a-f]{12}-cache\\.json$');
    expect(skill).toContain('^\\.coral-codex-[0-9a-f]{12}\\.lock$');
    expect(skill).toContain('Do not follow symlinks or delete any broader `.coral-*` pattern.');
  });

  it('names every file the script can leave behind in the uninstall list', () => {
    const source = readFileSync('clients/skills/statusline/coral-hud.mjs', 'utf-8');
    const skill = readFileSync('clients/skills/statusline/SKILL.md', 'utf-8');

    // Uninstall may not use a `.coral-*` glob, so coverage has to come from the list naming each file.
    // Deriving the expected names from the script's own literals is what makes a new writer fail here
    // rather than leave its file behind; `.coral-sessions.json` retains prompt text.
    const written = new Set([...source.matchAll(/'(\.coral-[a-z-]+(?:-cache)?\.(?:json|lock))'/gu)].map((m) => m[1]));
    expect(written.size).toBeGreaterThan(3);
    for (const basename of written) {
      expect(skill, `uninstall must name ${basename}`).toContain(`CONFIG_DIR/hud/${basename}`);
    }
  });
});

describe('coral-hud git segment', () => {
  it('reads the branch and the dirty flag from one porcelain-v2 response', () => {
    const out = [
      '# branch.oid 5a723e456033fb435ce1a8fa8f87541ce2416554',
      '# branch.head fix/launch-slot-permit',
      '1 .M N... 100644 100644 100644 e254674 e254674 clients/skills/statusline/coral-hud.mjs',
    ].join('\n');

    expect(parseGitStatus(out)).toEqual({ branch: 'fix/launch-slot-permit', dirty: true });
  });

  it('reports a clean tree when the response carries only header lines', () => {
    const out = '# branch.oid 5a723e456033fb435ce1a8fa8f87541ce2416554\n# branch.head main\n';

    expect(parseGitStatus(out)).toEqual({ branch: 'main', dirty: false });
  });

  it('falls back to the short oid on a detached head, and refuses one that names no revision', () => {
    const detached = '# branch.oid 5a723e456033fb435ce1a8fa8f87541ce2416554\n# branch.head (detached)\n';
    const unborn = '# branch.oid (initial)\n# branch.head (detached)\n';

    expect(parseGitStatus(detached)).toEqual({ branch: '5a723e4', dirty: false });
    expect(parseGitStatus(unborn)).toBeNull();
  });

  it('renders nothing when the branch could not be determined', () => {
    expect(formatGitSegment(null)).toBeNull();
    expect(visible(formatGitSegment({ branch: 'main', dirty: false }) as string)).toBe('⎇ main');
    expect(visible(formatGitSegment({ branch: 'main', dirty: true }) as string)).toBe('⎇ main*');
  });

  it('probes with --no-optional-locks so concurrent renders cannot contend for .git/index.lock', () => {
    const source = readFileSync('clients/skills/statusline/coral-hud.mjs', 'utf-8');

    expect(source).toContain("'git --no-optional-locks status --porcelain=v2 --branch'");
    expect(source).not.toMatch(/execSync\('git (?!--no-optional-locks)/u);
  });
});

describe('coral-hud shared-state writes', () => {
  it('routes every cache and session write through a temp path and a rename', () => {
    const source = readFileSync('clients/skills/statusline/coral-hud.mjs', 'utf-8');

    // Readers take no lock, so a direct write to one of these paths is visible to another session
    // half-written. The lock file is the deliberate exception: exclusivity there comes from `wx`.
    for (const target of ['CACHE_FILE', 'GIT_CACHE_FILE', 'SESSIONS_FILE', 'BACKEND_CACHE_FILE']) {
      expect(source, `${target} must be written via rename, not in place`).not.toMatch(
        new RegExp(`writeFileSync\\(\\s*${target}\\b`, 'u'),
      );
    }
    const lockWrites = source.split('\n').filter((line) => line.includes('writeFileSync(lockPath,'));
    expect(lockWrites.length).toBeGreaterThan(0);
    for (const line of lockWrites) expect(line).toContain("flag: 'wx'");
  });

  it('gives every timed subprocess a kill signal a stuck process cannot ignore', () => {
    const source = readFileSync('clients/skills/statusline/coral-hud.mjs', 'utf-8');

    // A timeout only removes the child if the signal it sends can be taken, and SIGTERM cannot be
    // taken by a process blocked in an uninterruptible wait.
    const calls = source.split('execSync(').slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const options = call.slice(0, call.indexOf('})'));
      if (options.includes('timeout:')) expect(options).toContain("killSignal: 'SIGKILL'");
    }
  });
});

describe('coral-hud terminal-safe rendering', () => {
  const hyperlink = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

  it('right-aligns against a line carrying a hyperlink, whose wrapper occupies no columns', () => {
    const line = `\x1b[36mcoral\x1b[0m ${hyperlink('http://127.0.0.1:41237', 'reef')}`;

    const composed = composeCoralThirdLine(line, null, 'what did I just ask', 80);

    expect(stripControlSequences(composed)).toHaveLength(80);
  });

  it('removes control bytes from transcript text before it reaches the terminal', () => {
    expect(stripControlSequences('hi \x1b[31mred\x1b[0m there')).toBe('hi red there');
    expect(stripControlSequences(`click ${hyperlink('http://evil', 'here')}`)).toBe('click here');
    expect(stripControlSequences('line\u0007bell')).toBe('line bell');
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

describe('coral-hud facts it cannot import', () => {
  it('shows the same Codex default the backend actually runs', () => {
    // A skill may not import from src/, so this string is a second home for one fact. The HUD would
    // otherwise keep printing the retired name, confidently, for every user who set no override.
    const hud = readFileSync('clients/skills/statusline/coral-hud.mjs', 'utf-8');
    const backend = readFileSync('src/providers/codex/request-mapping.ts', 'utf-8');

    const shown = /const CODEX_MODEL_DEFAULT = '([^']+)'/u.exec(hud)?.[1];
    const used = /const DEFAULT_CODEX_MODEL = '([^']+)'/u.exec(backend)?.[1];

    expect(shown, 'coral-hud.mjs must declare CODEX_MODEL_DEFAULT').toBeDefined();
    expect(used, 'request-mapping.ts must declare DEFAULT_CODEX_MODEL').toBeDefined();
    expect(shown).toBe(used);
  });
});

describe('coral-hud holds and staleness', () => {
  it('treats a hold stamped in the future as expired rather than as one that never ends', () => {
    const now = 1_000_000;

    expect(holdIsLive({ ts: now - 1_000, key: null, nonce: null }, now)).toBe(true);
    expect(holdIsLive({ ts: now - 60_000, key: null, nonce: null }, now)).toBe(false);
    // A clock that moved backward leaves the difference negative for the length of the skew.
    expect(holdIsLive({ ts: now + 60_000, key: null, nonce: null }, now)).toBe(false);
  });

  it('retires a cached subagent by its own age, since nothing else will', () => {
    const fresh = { a: { subagent_type: 'code-critic', ts: Date.now() } };
    const stranded = { a: { subagent_type: 'code-critic', ts: Date.now() - 31 * 60 * 1000 } };

    expect(visible(renderActivityStr(fresh, null) as string)).toContain('code-critic');
    expect(renderActivityStr(stranded, null)).toBeNull();
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
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'cfg') },
      encoding: 'utf-8',
    });
    rmSync(dir, { recursive: true, force: true });
    return result.stdout ?? '';
  }

  // Each extractor owns a different slot and one hides the others — a running agent outranks the
  // activity name — so a single transcript cannot prove all three are sanitized.
  const ESCAPE = '\u001b]0;pwned\u0007\u001b[2J';

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

describe('coral-hud probe classification', () => {
  it('counts only a git that ran and exited as having answered', () => {
    // execSync sets a numeric `status` exactly when the child produced an exit code.
    expect(probeAnswered({ status: 128, code: undefined, signal: null })).toBe(true);
    expect(probeAnswered({ status: 127, code: undefined, signal: null })).toBe(true);

    // These never produced a child, and N concurrent renders are how they happen.
    expect(probeAnswered({ status: null, code: 'EAGAIN', signal: null })).toBe(false);
    expect(probeAnswered({ status: null, code: 'EMFILE', signal: null })).toBe(false);
    expect(probeAnswered({ status: null, code: 'ETIMEDOUT', signal: 'SIGKILL' })).toBe(false);
    expect(probeAnswered({ status: null, code: 'ENOENT', signal: null })).toBe(false);
    expect(probeAnswered(undefined)).toBe(false);
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

  it('does not serve a branch from a cache entry stamped in the future', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-hud-clock-'));
    const cfg = join(root, 'cfg');
    const cacheFile = join(cfg, 'hud', '.coral-git-cache.json');
    renderIn(cfg, process.cwd());

    // A clock that moved backward leaves every entry stamped ahead of now; an unguarded
    // `now - ts <= TTL` stays true for the length of the skew and freezes the branch name.
    const cache = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, Record<string, unknown>>;
    const [key] = Object.keys(cache);
    cache[key] = { ts: Date.now() + 3_600_000, value: { branch: 'stale-branch', dirty: false }, backoffUntil: 0 };
    writeFileSync(cacheFile, JSON.stringify(cache));

    renderIn(cfg, process.cwd());

    const after = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, Record<string, number>>;
    expect(after[key]?.ts, 'a future stamp must not be served as fresh').toBeLessThanOrEqual(Date.now());
    rmSync(root, { recursive: true, force: true });
  });
});
