import { join } from 'node:path';

import type { Runtime } from '../runtime/ports.js';

export interface EquippedToolSummary {
  readonly id: string;
  readonly summary: string;
  readonly guidance?: readonly string[];
}

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
] as const;

type EquippedToolDefinition = (typeof EQUIP_AGENT_TOOLS)[number];

function engineBinaryPath(runtime: Pick<Runtime, 'paths'>, tool: EquippedToolDefinition): string {
  return join(runtime.paths.coral.engine.dataDir(tool.id), tool.bin);
}

function isInstalledBinary(runtime: Pick<Runtime, 'storage'>, path: string): boolean {
  try {
    return runtime.storage.statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveEquippedTools(runtime: Pick<Runtime, 'paths' | 'storage'>): EquippedToolSummary[] {
  try {
    return EQUIP_AGENT_TOOLS.filter((tool) => isInstalledBinary(runtime, engineBinaryPath(runtime, tool))).map(
      ({ id, summary, guidance }) => ({ id, summary, guidance }),
    );
  } catch {
    return [];
  }
}
