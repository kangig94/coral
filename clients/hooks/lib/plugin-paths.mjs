// Shared plugin path helpers for hook scripts.
// Emits strings that hooks inject into prompts / additionalContext so Claude
// can copy-paste them into its Bash tool — so commands returned here are
// already shell-quoted.

import { join } from 'node:path';

import { coralStateRoot } from './hook-utils.mjs';

export const BRIDGE_SUFFIX = '/bridge/coral-cli.cjs';

export function exportsJobsDir(flavor) {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return join(coralStateRoot(), base, 'jobs');
}

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

// Per-project Coral scratch dir for ephemeral hook state (ralph loop state, KB
// activity flags, compaction snapshots). Nested under the sandbox-writable root
// so ALL of Coral's /tmp state lives in one place that is writable both from
// hooks (outside the sandbox) and from a wrapped command (inside it).
export function projectTmpDir(projectDir) {
  return join(sandboxTmpDir(), 'coral', projectSlug(projectDir));
}

// Sandbox-WRITABLE scratch root for everything Coral keeps in /tmp. Inside a
// command sandbox this is the per-user scratch dir Claude Code exposes as
// $TMPDIR (`/tmp/claude-<uid>`); the hooks run OUTSIDE the sandbox where $TMPDIR
// is unset, so both sides derive the same path from the uid. This is the single
// point coupling us to the harness sandbox scratch-dir convention — kept here so
// it changes in one place. It is writable from inside a sandboxed command (the
// canonical `/tmp/coral` is not), so a wrapper can record its own liveness here.
// Tests set CORAL_WORK_ROOT_OVERRIDE to redirect it.
export function sandboxTmpDir() {
  return process.env.CORAL_WORK_ROOT_OVERRIDE
    || join('/tmp', `claude-${process.getuid?.() ?? 0}`);
}

// Resolves the project directory for hooks that mutate per-project state.
// CLAUDE_PROJECT_DIR is the primary source; hook payloads always carry `cwd`
// as a fallback (per Claude Code common-input-fields contract); '.' is the
// final escape hatch so downstream projectSlug/path calls don't see undefined.
export function projectDirFromInput(input, fallback = '.') {
  return process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? fallback;
}
