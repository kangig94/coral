import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { resolveEquippedTools } from '../../../clients/hooks/lib/equip-tools.mjs';
// @ts-expect-error — reuse the real path logic so a flavor/slot drift fails the test.
import { buildFlavor, coralStateRoot } from '../../../clients/hooks/lib/hook-utils.mjs';

const createdRoots: string[] = [];
let savedHome: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  // Default config dir → no by-config slot, so coralStateRoot() == <HOME>/.coral.
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
// test tracks coralStateRoot()/buildFlavor() (config slot + flavor) instead of
// hardcoding a path that could silently drift from the code under test.
function codebaseMemoryBinDir(): string {
  const dataDir = buildFlavor() === 'dev' ? 'data-dev' : 'data';
  return join(coralStateRoot(), dataDir, 'engines', 'codebase-memory');
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
    expect(tools[0].summary).toContain('mandatory first stop');
    expect(tools[0].guidance.join('\n')).toContain('mcp__codebase_memory_mcp namespace first');
    expect(tools[0].guidance.join('\n')).toContain('search_graph');
    expect(tools[0].guidance.join('\n')).toContain('codebase-memory-mcp cli <tool>');
    expect(tools[0].guidance.join('\n')).toContain('both MCP and shell CLI graph access');
  });

  it('stops surfacing the instant the binary is removed by any means (no equip uninstall needed)', () => {
    tmpHome();
    const dir = codebaseMemoryBinDir();
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'codebase-memory-mcp');
    writeFileSync(bin, 'binary');
    expect(resolveEquippedTools().map((t: { id: string }) => t.id)).toEqual(['codebase-memory']);

    rmSync(bin);
    expect(resolveEquippedTools()).toEqual([]);
  });

  it('does not surface a like-named directory (binary must be a regular file)', () => {
    tmpHome();
    const dir = codebaseMemoryBinDir();
    // Create `codebase-memory-mcp` as a DIRECTORY, not a file.
    mkdirSync(join(dir, 'codebase-memory-mcp'), { recursive: true });
    expect(resolveEquippedTools()).toEqual([]);
  });

  it('honors the per-config-dir slot (CLAUDE_CONFIG_DIR partitions the engine tree)', () => {
    const home = tmpHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, 'alt-config'); // non-default → slotted stateRoot
    const slottedDir = codebaseMemoryBinDir();
    expect(slottedDir).toContain(join('.coral', 'by-config'));
    mkdirSync(slottedDir, { recursive: true });
    writeFileSync(join(slottedDir, 'codebase-memory-mcp'), 'binary');

    expect(resolveEquippedTools().map((t: { id: string }) => t.id)).toEqual(['codebase-memory']);
  });
});
