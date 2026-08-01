// Agent-facing tools that Coral ships `/equip` support for. Surfaced in the
// session inject (under the CLI line) so the agent knows what is available.
//
// Detection is a LIVE check: each tool's binary lives at a path the code already
// knows (Coral's engine data tree, where `/equip` installs it), so we just test
// whether that binary exists right now — independent of how it was installed and
// of whether `/equip`'s own bookkeeping ran. A binary removed by any means (not
// just `equip uninstall`) immediately stops surfacing. Works the same for
// MCP-server tools and CLI-only tools — presence of the binary is the signal.
//
// This catalog is the agent-facing install-only subset of `/equip` packages —
// it intentionally excludes bundled artifacts the agent never calls directly
// (e.g. the Kiwi tokenizer in `src/expansion/install-only.ts`). Hooks are
// self-contained and must not import from `src/`, so keep it in lockstep with
// the expansion catalog and account-neutral `coralStateRoot` source.

import { statSync } from 'node:fs';
import { join } from 'node:path';

import { buildFlavor, coralStateRoot } from './hook-utils.mjs';

const EQUIP_AGENT_TOOLS = [
  {
    id: 'codebase-memory',
    bin: 'codebase-memory-mcp',
    summary:
      'highest-priority, mandatory first stop for every code task. Use it before grep, file reads, edits, reviews, debugging, or behavior analysis.',
    guidance: [
      'Use the live MCP tools in the mcp__codebase_memory_mcp namespace first.',
      'Start with search_graph to find symbols, classes, routes, and likely owners before opening files.',
      'Use trace_path to inspect callers, callees, and data flow so behavior changes do not miss hidden call sites.',
      'Use get_code_snippet for targeted source after graph discovery, and query_graph/get_architecture for broader relationships or module context.',
      "If MCP calls fail or its transport is unavailable (for example, 'Transport closed'), do not skip Codebase Memory: invoke the same tool through the shell as `codebase-memory-mcp cli <tool> '<json-args>'`.",
      'Manual grep/read is a fallback only for string literals, config/non-code files, or after both MCP and shell CLI graph access are unavailable or insufficient.',
    ],
  },
];

// Engine data tree mirrors `src/infra/path/engine.ts`: <stateRoot>/gen2/<data|data-dev>/engines/<id>/.
function engineBinaryPath(id, bin, flavor = buildFlavor(), stateRoot = coralStateRoot()) {
  const dataDir = flavor === 'dev' ? 'data-dev' : 'data';
  return join(stateRoot, 'gen2', dataDir, 'engines', id, bin);
}

// Mirror `src/expansion/shell-installer.ts`: a tool counts as installed only when
// its binary path is a regular file (a like-named directory is not the tool).
function isInstalledBinary(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Live snapshot of equip-supported tools whose binary is present. Fail-open: any
// fs error yields [], so a session never blocks on this advisory surface.
export function resolveEquippedTools() {
  try {
    return EQUIP_AGENT_TOOLS.filter((tool) => isInstalledBinary(engineBinaryPath(tool.id, tool.bin))).map((tool) => ({
      id: tool.id,
      summary: tool.summary,
      guidance: tool.guidance,
    }));
  } catch {
    return [];
  }
}
