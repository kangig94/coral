import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

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

    const written = new Set([...source.matchAll(/'(\.coral-[a-z-]+(?:-cache)?\.(?:json|lock))'/gu)].map((m) => m[1]));
    expect(written.size).toBeGreaterThan(3);
    for (const basename of written) {
      expect(skill, `uninstall must name ${basename}`).toContain(`CONFIG_DIR/hud/${basename}`);
    }

    for (const pattern of [
      '^\\.coral-cache\\.json\\.tmp-[0-9]+$',
      '^\\.coral-git-cache\\.json\\.tmp-[0-9]+$',
      '^\\.coral-sessions\\.json\\.tmp-[0-9]+$',
      '^\\.coral-backend-cache\\.json\\.tmp-[0-9]+$',
      '^\\.coral-codex-[0-9a-f]{12}-cache\\.json\\.tmp-[0-9]+$',
      '^auth\\.json\\.tmp-[0-9]+$',
    ]) {
      expect(skill).toContain(pattern);
    }
  });
});

describe('coral-hud backend state end to end', () => {
  const RED_CORAL = '\x1b[31mcoral\x1b[0m';
  const DIM_CORAL = '\x1b[2mcoral\x1b[0m';
  const ORANGE_CORAL = '\x1b[38;2;255;133;89mcoral\x1b[0m';

  function renderWithBackendRecord(record?: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'hud-backend-'));
    const home = join(root, 'home');
    const cfg = join(root, 'cfg');
    try {
      if (record !== undefined) {
        const runDir = join(home, '.coral', 'gen2', 'run');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify(record));
      }
      const result = spawnSync(process.execPath, [join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')], {
        input: JSON.stringify({ cwd: root, session_id: 'backend-state', model: { display_name: 'O' } }),
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: join(root, 'codex'), HOME: home },
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      return result.stdout ?? '';
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function renderWithBackendRecordAsync(record: Record<string, unknown>): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'hud-backend-'));
    const home = join(root, 'home');
    const cfg = join(root, 'cfg');
    try {
      const runDir = join(home, '.coral', 'gen2', 'run');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'coordinator.json'), JSON.stringify(record));
      const result = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')], {
          env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: join(root, 'codex'), HOME: home },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => (stdout += chunk));
        child.once('error', reject);
        child.once('close', (status) => resolve({ status, stdout }));
        child.stdin.end(JSON.stringify({ cwd: root, session_id: 'backend-state', model: { display_name: 'O' } }));
      });
      expect(result.status).toBe(0);
      return result.stdout;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('renders a dead recorded backend in red', () => {
    const exited = spawnSync(process.execPath, ['-e', '']);
    if (exited.pid === undefined) throw new Error('failed to start the dead-pid fixture');

    expect(renderWithBackendRecord({ pid: exited.pid, port: 1, bootToken: 'test' })).toContain(RED_CORAL);
  });

  it('renders a live backend with an unreachable health endpoint dimly', () => {
    expect(renderWithBackendRecord({ pid: process.pid, port: 1, bootToken: 'test' })).toContain(DIM_CORAL);
  });

  it('renders an unprobeable backend with an unreachable health endpoint dimly', () => {
    const rendered = renderWithBackendRecord({ pid: 1, port: 1, bootToken: 'test' });

    expect(rendered).toContain(DIM_CORAL);
    expect(rendered).not.toContain(RED_CORAL);
  });

  it('probes health for pid 1 and renders a reachable backend in orange', async () => {
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health?detailed=1') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('failed to start the health fixture');
      const rendered = await renderWithBackendRecordAsync({ pid: 1, port: address.port, bootToken: 'test' });

      expect(rendered).toContain(ORANGE_CORAL);
      expect(rendered).not.toContain(RED_CORAL);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it.each([{ pid: '123' }, { pid: -1 }, { pid: 1.5 }, { pid: 0 }, { pid: 2_147_483_648 }])(
    'hides the backend slot for invalid pid $pid',
    ({ pid }) => {
      expect(renderWithBackendRecord({ pid, port: 1, bootToken: 'test' })).not.toContain('coral');
    },
  );

  it('hides the backend slot when no discovery record exists', () => {
    expect(renderWithBackendRecord()).not.toContain('coral');
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

describe('coral-hud stale lock recovery', () => {
  function renderAfterReplacingStaleLock(lockName: string, key: string): string | undefined {
    const root = mkdtempSync(join(tmpdir(), 'coral-hud-lock-'));
    const cfg = join(root, 'cfg');
    const hud = join(cfg, 'hud');
    const lockPath = join(hud, lockName);
    const preload = join(root, 'replace-lock.cjs');
    try {
      mkdirSync(hud, { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ ts: Date.now() - 60_000, key, nonce: 'stale' }));
      writeFileSync(
        preload,
        [
          "const fs = require('node:fs');",
          "const { syncBuiltinESMExports } = require('node:module');",
          `const target = ${JSON.stringify(lockPath)};`,
          `const fresh = ${JSON.stringify(JSON.stringify({ ts: Date.now(), key, nonce: 'fresh' }))};`,
          'const readFile = fs.readFileSync;',
          'let replaced = false;',
          'fs.readFileSync = (...args) => {',
          '  const value = readFile(...args);',
          '  if (!replaced && args[0] === target) {',
          '    replaced = true;',
          '    fs.writeFileSync(target, fresh);',
          '  }',
          '  return value;',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );

      spawnSync(
        process.execPath,
        ['--require', preload, join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')],
        {
          input: JSON.stringify({ cwd: root, session_id: lockName, model: { display_name: 'O' } }),
          env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: join(root, 'codex') },
          encoding: 'utf-8',
        },
      );

      return existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf-8')).nonce : undefined;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('keeps a replacement git lock instead of deleting it as stale', () => {
    expect(renderAfterReplacingStaleLock('.coral-git.lock', 'stalled-repository')).toBe('fresh');
  });

  it('keeps a replacement fetch lock instead of deleting it as stale', () => {
    expect(renderAfterReplacingStaleLock('.coral-claude.lock', 'claude')).toBe('fresh');
  });

  it('holds the git lock while publishing a stale repository fence', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-hud-fence-'));
    const cfg = join(root, 'cfg');
    const hud = join(cfg, 'hud');
    const lockPath = join(hud, '.coral-git.lock');
    const cachePath = join(hud, '.coral-git-cache.json');
    const record = join(root, 'lock-state');
    const preload = join(root, 'observe-rename.cjs');
    try {
      mkdirSync(hud, { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ ts: Date.now() - 60_000, key: 'stalled-repository', nonce: 'stale' }));
      writeFileSync(
        preload,
        [
          "const fs = require('node:fs');",
          "const { syncBuiltinESMExports } = require('node:module');",
          `const cachePath = ${JSON.stringify(cachePath)};`,
          `const lockPath = ${JSON.stringify(lockPath)};`,
          `const record = ${JSON.stringify(record)};`,
          'const rename = fs.renameSync;',
          'fs.renameSync = (...args) => {',
          '  if (args[1] === cachePath) fs.writeFileSync(record, fs.existsSync(lockPath) ? "locked" : "unlocked");',
          '  return rename(...args);',
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );

      spawnSync(
        process.execPath,
        ['--require', preload, join(process.cwd(), 'clients/skills/statusline/coral-hud.mjs')],
        {
          input: JSON.stringify({ cwd: root, session_id: 'fence', model: { display_name: 'O' } }),
          env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: join(root, 'codex') },
          encoding: 'utf-8',
        },
      );

      expect(readFileSync(record, 'utf-8')).toBe('locked');
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

describe('coral-hud Codex credential boundary', () => {
  it('reads auth.json and never writes it or refreshes the token', () => {
    const source = readFileSync('clients/skills/statusline/coral-hud.mjs', 'utf-8');

    // The Codex CLI owns this file's freshness. Two writers of one refresh token means whichever
    // rotates second invalidates the other, and the loser is logged out with nothing to say why.
    expect(source).not.toContain('auth.openai.com');
    expect(source).not.toContain('grant_type');
    expect(source).not.toContain('refresh_token');
    for (const write of source.split('\n').filter((line) => /writeFileSync|renameSync/u.test(line))) {
      expect(write, 'no write may target auth.json').not.toContain('authPath');
    }
  });
});
