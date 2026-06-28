import { dirname } from 'node:path';

import { z } from 'zod';

import type { Runtime } from '../runtime/ports.js';
import { BUNDLED_INSTALL_ONLY_PACKAGES } from './bundled.js';
import { INSTALL_ONLY_PACKAGES } from './install-only.js';

export const EQUIPPED_TOOLS_SNAPSHOT_VERSION = 1;

export const equippedToolSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();
export type EquippedTool = z.infer<typeof equippedToolSchema>;

export const equippedToolsSnapshotSchema = z
  .object({
    version: z.literal(EQUIPPED_TOOLS_SNAPSHOT_VERSION),
    tools: z.array(equippedToolSchema),
  })
  .strict();
export type EquippedToolsSnapshot = z.infer<typeof equippedToolsSnapshotSchema>;

const BUNDLED_INSTALL_ONLY_IDS: ReadonlySet<string> = new Set(
  BUNDLED_INSTALL_ONLY_PACKAGES.map((manifest) => manifest.id),
);

/**
 * Agent-facing tools installed via `/equip` — the set the session-start hook
 * advertises to the agent. These are install-only packages that ship a tool the
 * agent invokes directly (e.g. an MCP server). Coral's own engines (FTS/vector/
 * embedding) and bundled install-only artifacts (e.g. the Kiwi tokenizer model)
 * are deliberately excluded: they are internal plumbing the agent never calls,
 * reached only transitively through `kb` commands. Only externally-contributed
 * packages surface. Computed from local install state alone — no coordinator,
 * socket, or live equipment status involved.
 */
export function computeEquippedTools(runtime: Runtime): EquippedTool[] {
  const tools: EquippedTool[] = [];
  for (const manifest of INSTALL_ONLY_PACKAGES) {
    if (BUNDLED_INSTALL_ONLY_IDS.has(manifest.id)) {
      continue;
    }
    if (!manifest.installer.inspect(runtime, manifest.id).installed) {
      continue;
    }
    tools.push({ id: manifest.id, summary: manifest.agentSummary ?? manifest.description });
  }
  return tools;
}

/**
 * Refresh the run-dir snapshot that the session-start hook reads. A presentation
 * projection must never break boot or an install, so the whole write is
 * best-effort: on any failure the prior snapshot stands. The hook fails open on
 * a missing or malformed file, so a skipped write simply omits the section.
 */
export function writeEquippedToolsSnapshot(runtime: Runtime): void {
  try {
    const snapshot: EquippedToolsSnapshot = {
      version: EQUIPPED_TOOLS_SNAPSHOT_VERSION,
      tools: computeEquippedTools(runtime),
    };
    const path = runtime.paths.coral.coordinator.equippedToolsFile;
    runtime.storage.mkdirSync(dirname(path), { recursive: true });
    runtime.storage.writeAtomicSync(path, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Best-effort projection refresh.
  }
}
