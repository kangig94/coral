import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveEquippedTools } from '#src/expansion/equipped-tools.js';
import type { Runtime } from '#src/runtime/ports.js';

type RuntimeSlice = Pick<Runtime, 'paths' | 'storage'>;

function statResult(isFile: boolean): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean } {
  return {
    size: 0,
    mtimeMs: 0,
    isDirectory: () => !isFile,
    isFile: () => isFile,
  };
}

function runtimeWithStat(files: Map<string, boolean>): RuntimeSlice {
  return {
    paths: {
      coral: {
        engine: {
          dataDir: (name: string) => join('/engines', name),
        },
      },
    },
    storage: {
      statSync: (path: string) => {
        const isFile = files.get(path);
        if (isFile === undefined) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        }
        return statResult(isFile);
      },
    },
  } as RuntimeSlice;
}

describe('resolveEquippedTools', () => {
  it('returns [] when the supported engine binary is absent', () => {
    expect(resolveEquippedTools(runtimeWithStat(new Map()))).toEqual([]);
  });

  it('surfaces codebase-memory when its engine binary is present', () => {
    const bin = join('/engines', 'codebase-memory', 'codebase-memory-mcp');

    const tools = resolveEquippedTools(runtimeWithStat(new Map([[bin, true]])));

    expect(tools.map((tool) => tool.id)).toEqual(['codebase-memory']);
    expect(tools[0].summary).toContain('mandatory first stop');
    expect(tools[0].guidance?.join('\n')).toContain('mcp__codebase_memory_mcp namespace first');
    expect(tools[0].guidance?.join('\n')).toContain('search_graph');
    expect(tools[0].guidance?.join('\n')).toContain('codebase-memory-mcp cli <tool>');
    expect(tools[0].guidance?.join('\n')).toContain('both MCP and shell CLI graph access');
  });

  it('does not surface a directory where the binary should be', () => {
    const bin = join('/engines', 'codebase-memory', 'codebase-memory-mcp');

    expect(resolveEquippedTools(runtimeWithStat(new Map([[bin, false]])))).toEqual([]);
  });

  it('fails open when a test/runtime slice does not implement engine paths', () => {
    const runtime = {
      paths: { coral: {} },
      storage: { statSync: () => statResult(true) },
    } as unknown as RuntimeSlice;

    expect(resolveEquippedTools(runtime)).toEqual([]);
  });
});
