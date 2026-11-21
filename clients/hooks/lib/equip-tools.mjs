import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { findLocalExecutable, readMountTable } from './path-executable.mjs';

export const CODEBASE_MEMORY_TOOL = {
  id: 'codebase-memory',
  bin: 'codebase-memory-mcp',
  standardBinDir: '.local/bin',
  summary:
    'highest-priority, mandatory first stop for every code task. Use it before grep, file reads, edits, reviews, debugging, or behavior analysis.',
  guidance: [
    'Use the live MCP tools in the mcp__codebase_memory_mcp namespace first.',
    'Start with search_graph to find symbols, classes, routes, and likely owners before opening files.',
    'Use trace_path to inspect callers, callees, and data flow so behavior changes do not miss hidden call sites.',
    'Use get_code_snippet for targeted source after graph discovery, and query_graph/get_architecture for broader relationships or module context.',
    "If MCP calls fail or its transport is unavailable (for example, 'Transport closed'), do not skip Codebase Memory: invoke the same tool through the shell as `codebase-memory-mcp cli <tool> '<json-args>'`.",
    'For a standard installation missing from your shell PATH, use `$HOME/.local/bin/codebase-memory-mcp`.',
    'Manual grep/read is a fallback only for string literals, config/non-code files, or after both MCP and shell CLI graph access are unavailable or insufficient.',
  ],
};

export const EQUIP_AGENT_TOOLS = [CODEBASE_MEMORY_TOOL];

const hookEnv = { get: (name) => process.env[name], homedir, platform, cwd: () => process.cwd() };
const hookStorage = {
  lstatSync,
  readFileSync,
  assertExecutableSync: (file) => accessSync(file, constants.X_OK),
  statSync,
};

export function standardToolPath(tool, home) {
  return join(home, tool.standardBinDir, tool.bin);
}

export function isExecutableFile(storage, path) {
  try {
    if (!storage.statSync(path).isFile()) return false;
    storage.assertExecutableSync(path);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(tool, env) {
  const pathDirs = env.get('PATH')?.split(delimiter) ?? [];
  const cwd = env.cwd();
  return new Set(pathDirs.map((dir) => resolve(cwd, dir, tool.bin)));
}

export function findEquippedTool(tool, env, storage, excludedPath) {
  const mounts = readMountTable(env.platform(), storage);
  const candidates = [...pathCandidates(tool, env)].filter((candidate) => candidate !== excludedPath);
  const local = findLocalExecutable(candidates, storage, mounts);
  if (local !== null) return local;

  const standard = standardToolPath(tool, env.homedir());
  return standard !== excludedPath && isExecutableFile(storage, standard) ? standard : null;
}

export function resolveEquippedTools(env = hookEnv, storage = hookStorage) {
  try {
    const equipped = [];
    for (const tool of EQUIP_AGENT_TOOLS) {
      if (findEquippedTool(tool, env, storage) !== null) {
        const { id, summary, guidance } = tool;
        equipped.push({ id, summary, guidance });
      }
    }
    return equipped;
  } catch {
    return [];
  }
}
