import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { resolveEquippedTools } from '../../../clients/hooks/lib/equip-tools.mjs';
// @ts-expect-error — reuse the real path logic so a flavor drift fails the test.
import { buildFlavor, coralStateRoot } from '../../../clients/hooks/lib/hook-utils.mjs';

const createdRoots: string[] = [];
let savedHome: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  // Provider account selectors never alter the Coral-owned state root.
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-equip-tools-'));
  createdRoots.push(root);
  process.env.HOME = root;
  return root;
}

// Resolve the codebase-memory engine dir the SAME way the hook does, so this
// test tracks coralStateRoot()/buildFlavor() (account-neutral root + flavor) instead of
// hardcoding a path that could silently drift from the code under test.
function codebaseMemoryBinDir(): string {
  const dataDir = buildFlavor() === 'dev' ? 'data-dev' : 'data';
  return join(coralStateRoot(), 'gen2', dataDir, 'engines', 'codebase-memory');
}

describe('resolveEquippedTools', () => {
  it('returns [] when no equip-supported binary is present', () => {
    tmpHome();
    expect(resolveEquippedTools()).toEqual([]);
  });

  it('surfaces codebase-memory once its binary exists in the engine data tree', () => {
    tmpHome();
    const dir = codebaseMemoryBinDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codebase-memory-mcp'), 'binary');

    const tools = resolveEquippedTools();
    expect(tools.map((t: { id: string }) => t.id)).toEqual(['codebase-memory']);
  });
});
