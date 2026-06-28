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
// This catalog mirrors the equip-supported set in `src/expansion/install-only.ts`
// (hooks are self-contained and must not import from `src/`); keep it in lockstep
// the same way `coralStateRoot`/`claudeConfigSlot` mirror their `src` originals.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildFlavor, coralStateRoot } from './hook-utils.mjs';

const EQUIP_AGENT_TOOLS = [
  {
    id: 'codebase-memory',
    bin: 'codebase-memory-mcp',
    summary:
      'indexes this codebase into a queryable graph (symbols, calls, data flow) exposed as MCP tools (search_graph, trace_path, get_code_snippet, search_code, get_architecture) — reach for it first on code-discovery questions before manual grep/read',
  },
];

// Engine data tree mirrors `src/infra/path/engine.ts`: <stateRoot>/<data|data-dev>/engines/<id>/.
function engineBinaryPath(id, bin) {
  const dataDir = buildFlavor() === 'dev' ? 'data-dev' : 'data';
  return join(coralStateRoot(), dataDir, 'engines', id, bin);
}

// Live snapshot of equip-supported tools whose binary is present. Fail-open: any
// fs error yields [], so a session never blocks on this advisory surface.
export function resolveEquippedTools() {
  try {
    return EQUIP_AGENT_TOOLS.filter((tool) => existsSync(engineBinaryPath(tool.id, tool.bin))).map((tool) => ({
      id: tool.id,
      summary: tool.summary,
    }));
  } catch {
    return [];
  }
}
