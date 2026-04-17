// Shared plugin path helpers for hook scripts.
// Emits strings that hooks inject into prompts / additionalContext so Claude
// can copy-paste them into its Bash tool — so commands returned here are
// already shell-quoted.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BRIDGE_SUFFIX = '/bridge/coral-cli.cjs';
export const JOBS_DIR = join(tmpdir(), 'coral-jobs');

export function activeBridgePath(pluginRoot) {
  return `${pluginRoot}${BRIDGE_SUFFIX}`;
}

// Double-quoted so the string pastes cleanly into LLM-driven Bash calls:
// plugin paths never contain `$` or backtick in practice, but may contain
// apostrophes on some systems, which makes single-quoting awkward.
export function activeBridgeCommand(pluginRoot) {
  return `node "${activeBridgePath(pluginRoot)}"`;
}

export function projectSlug(projectDir) {
  return projectDir.replace(/\//g, '-');
}

export function projectTmpDir(projectDir) {
  return join(tmpdir(), 'coral', projectSlug(projectDir));
}

// Resolves the project directory for hooks that mutate per-project state.
// CLAUDE_PROJECT_DIR is the primary source; hook payloads always carry `cwd`
// as a fallback (per Claude Code common-input-fields contract); '.' is the
// final escape hatch so downstream projectSlug/path calls don't see undefined.
export function projectDirFromInput(input, fallback = '.') {
  return process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? fallback;
}
