import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { resolveEquippedTools } from '../../../hooks/lib/equip-tools.mjs';

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

function codebaseMemoryBinDir(home: string): string {
  // Prod flavor (repo bridge manifest): <home>/.coral/data/engines/<id>/.
  return join(home, '.coral', 'data', 'engines', 'codebase-memory');
}

describe('resolveEquippedTools', () => {
  it('returns [] when no equip-supported binary is present', () => {
    tmpHome();
    expect(resolveEquippedTools()).toEqual([]);
  });

  it('surfaces codebase-memory once its binary exists in the engine data tree', () => {
    const home = tmpHome();
    const dir = codebaseMemoryBinDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codebase-memory-mcp'), 'binary');

    const tools = resolveEquippedTools();
    expect(tools.map((t: { id: string }) => t.id)).toEqual(['codebase-memory']);
    expect(tools[0].summary).toContain('search_graph');
  });

  it('stops surfacing the instant the binary is removed by any means (no equip uninstall needed)', () => {
    const home = tmpHome();
    const dir = codebaseMemoryBinDir(home);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'codebase-memory-mcp');
    writeFileSync(bin, 'binary');
    expect(resolveEquippedTools().map((t: { id: string }) => t.id)).toEqual(['codebase-memory']);

    rmSync(bin);
    expect(resolveEquippedTools()).toEqual([]);
  });
});
