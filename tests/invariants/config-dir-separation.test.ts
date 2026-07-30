import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import { composeCoralPaths, resolveClaudeConfigDir } from '#src/infra/path/index.js';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';

// Coral-owned state belongs to the daemon, not to whichever provider account
// invoked it. Provider selectors must never enter path composition.
const STATE_FAMILIES = ['store', 'coordinator', 'exports', 'engine', 'projects'] as const;

function leafPaths(record: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const value of Object.values(record)) {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') out.push(...leafPaths(value as Record<string, unknown>));
  }
  return out;
}

describe('account-neutral Coral state tree', () => {
  const flavor = resolveBuildFlavor({});

  it('resolveClaudeConfigDir falls back to ~/.claude only when unset/empty', () => {
    expect(resolveClaudeConfigDir(undefined, '/home/u')).toBe('/home/u/.claude');
    expect(resolveClaudeConfigDir('', '/home/u')).toBe('/home/u/.claude');
    expect(resolveClaudeConfigDir('/custom/dir', '/home/u')).toBe('/custom/dir');
  });

  const shared = composeCoralPaths(flavor);

  it.each(STATE_FAMILIES)('%s family never contains a by-config segment', (family) => {
    const sharedLeaves = leafPaths(shared[family] as unknown as Record<string, unknown>);
    expect(sharedLeaves.length).toBeGreaterThan(0);
    for (const path of sharedLeaves) {
      expect(path).not.toContain('by-config');
    }
  });

  it('the projects dataDir accessor is account-neutral', () => {
    expect(shared.projects.dataDir('acme/repo')).not.toContain('by-config');
  });

  it('KB runtime artifacts and the markdown vault are account-neutral', () => {
    expect(kbRuntimePaths(flavor).root).not.toContain('by-config');
    for (const path of leafPaths(shared.corpus as unknown as Record<string, unknown>)) {
      expect(path).not.toContain('by-config');
    }
  });

  it('ignores an existing legacy by-config tree when composing canonical paths', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-account-neutral-paths-'));
    try {
      mkdirSync(join(baseDir, 'by-config', 'legacy-account', 'run'), { recursive: true });
      const paths = composeCoralPaths(flavor, { baseDir });
      for (const family of STATE_FAMILIES) {
        for (const path of leafPaths(paths[family] as unknown as Record<string, unknown>)) {
          expect(path).toContain(baseDir);
          expect(path).not.toContain('by-config');
        }
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
