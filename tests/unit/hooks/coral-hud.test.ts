import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// prettier-ignore
// @ts-expect-error - statusline hooks are executable .mjs files without TS declarations.
import { codexCacheKey, composeCoralThirdLine, coralBackendInfoPath, formatGitSegment, hudCacheFile, hudFetchLockPath, parseGitStatus, renderTextProjectionIndicator, shouldUseClaudeKeychain } from '../../../clients/skills/statusline/coral-hud.mjs';

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
