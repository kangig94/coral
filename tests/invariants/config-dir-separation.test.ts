import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import { claudeConfigSlot, composeCoralPaths, resolveClaudeConfigDir } from '#src/infra/path/index.js';
import { kbRuntimeDir } from '#src/kb/paths.js';

// State families partition by config-dir slot so two Claude config dirs (each
// installing its own plugin + backend daemon) never share a socket, store, or
// job tree. The KB/corpus family deliberately stays shared. Mirrors the slot
// logic the session-start hook replicates (hooks/lib/hook-utils.mjs).
const STATE_FAMILIES = ['store', 'coordinator', 'exports', 'engine', 'projects'] as const;

function leafPaths(record: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const value of Object.values(record)) {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object') out.push(...leafPaths(value as Record<string, unknown>));
  }
  return out;
}

describe('config-dir state-tree separation', () => {
  const flavor = resolveBuildFlavor({});

  it('the default config dir (~/.claude) maps to no slot — shared ~/.coral tree', () => {
    expect(claudeConfigSlot(join(homedir(), '.claude'), homedir())).toBeUndefined();
    expect(claudeConfigSlot('/home/u/.claude', '/home/u')).toBeUndefined();
  });

  it('a non-default config dir maps to a stable 8-char hex slot', () => {
    const slot = claudeConfigSlot('/home/u/.claude-work', '/home/u');
    expect(slot).toMatch(/^[0-9a-f]{8}$/u);
    expect(claudeConfigSlot('/home/u/.claude-work', '/home/u')).toBe(slot);
    expect(claudeConfigSlot('/home/u/.claude-other', '/home/u')).not.toBe(slot);
  });

  it('resolveClaudeConfigDir falls back to ~/.claude only when unset/empty', () => {
    expect(resolveClaudeConfigDir(undefined, '/home/u')).toBe('/home/u/.claude');
    expect(resolveClaudeConfigDir('', '/home/u')).toBe('/home/u/.claude');
    expect(resolveClaudeConfigDir('/custom/dir', '/home/u')).toBe('/custom/dir');
  });

  const slot = 'abc12345';
  const shared = composeCoralPaths(flavor);
  const slotted = composeCoralPaths(flavor, { configSlot: slot });

  it.each(STATE_FAMILIES)('%s family is partitioned under by-config/<slot>', (family) => {
    const sharedLeaves = leafPaths(shared[family] as unknown as Record<string, unknown>);
    const slottedLeaves = leafPaths(slotted[family] as unknown as Record<string, unknown>);
    expect(slottedLeaves.length).toBe(sharedLeaves.length);
    expect(slottedLeaves.length).toBeGreaterThan(0);
    for (const path of slottedLeaves) {
      expect(path).toContain(`by-config/${slot}`);
    }
    for (const path of sharedLeaves) {
      expect(path).not.toContain('by-config');
    }
  });

  it('the default (no slot) state tree contains no by-config segment (backward compat)', () => {
    for (const family of STATE_FAMILIES) {
      for (const path of leafPaths(shared[family] as unknown as Record<string, unknown>)) {
        expect(path).not.toContain('by-config');
      }
    }
  });

  it('the projects dataDir accessor (a function, not a leaf string) is also slotted', () => {
    expect(slotted.projects.dataDir('acme/repo')).toContain(`by-config/${slot}`);
    expect(shared.projects.dataDir('acme/repo')).not.toContain('by-config');
  });

  it('KB runtime artifacts (index/touch-journal) partition by slot; the markdown vault does not', () => {
    // The vault (corpus.kbRoot) is shared knowledge; the runtime tree is daemon state.
    expect(kbRuntimeDir(flavor, slot)).toContain(`by-config/${slot}`);
    expect(kbRuntimeDir(flavor)).not.toContain('by-config');
    expect(slotted.corpus.kbRoot).not.toContain('by-config');
  });

  it('the KB/corpus markdown vault is NOT partitioned — knowledge is shared across config dirs', () => {
    expect(slotted.corpus.kbRoot).toBe(shared.corpus.kbRoot);
    for (const path of leafPaths(slotted.corpus as unknown as Record<string, unknown>)) {
      expect(path).not.toContain('by-config');
    }
  });
});
