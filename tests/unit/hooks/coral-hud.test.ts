import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// prettier-ignore
// @ts-expect-error - statusline hooks are executable .mjs files without TS declarations.
import { codexCacheKey, composeCoralThirdLine, coralBackendInfoPath, hudCacheFile, hudFetchLockPath, renderTextProjectionIndicator, shouldUseClaudeKeychain } from '../../../clients/skills/statusline/coral-hud.mjs';

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
    expect(coralBackendInfoPath('/home/operator')).toBe('/home/operator/.coral/run/coordinator.json');
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
