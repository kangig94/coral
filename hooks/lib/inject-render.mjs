// Renders INJECT.md into the text injected as additionalContext by
// session-start and subagent-start hooks.
//
// Contract:
//   - SessionStart: asOwner=true — keep the OWNER_ONLY block (orchestrator
//     privileges like workflow owner propagation and source management)
//   - SubagentStart: asOwner=false — strip OWNER_ONLY (subagents don't
//     promote memos or manage sources), but keep SESSION_ID_ONLY since
//     subagents share the parent's session_id and can write memos under
//     the same owner scope.
//   - {{EQUIPPED_TOOLS}}: rendered only when the caller passes `equippedTools`
//     (session-start and subagent-start do). The placeholder is stripped
//     otherwise.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coralProjectDir, resolveKbRoot, resolveProjectSource } from './hook-utils.mjs';
import { activeBridgeCommand } from './plugin-paths.mjs';

const OWNER_ONLY_RE = /<!-- OWNER_ONLY:BEGIN -->[\s\S]*?<!-- OWNER_ONLY:END -->\n?/g;
const KB_ONLY_RE = /<!-- KB_ONLY:BEGIN -->[\s\S]*?<!-- KB_ONLY:END -->\n?/g;

function stripOwnerOnly(text) {
  return text.replace(OWNER_ONLY_RE, '');
}

function stripKbOnly(text) {
  return text.replace(KB_ONLY_RE, '');
}

// Render the equipped-tools block that follows the `CLI:` line. Empty string
// when there are no tools (or the caller omits them), so the placeholder
// vanishes cleanly and the section stays absent.
function renderEquippedTools(equippedTools) {
  if (!Array.isArray(equippedTools) || equippedTools.length === 0) return '';
  const lines = equippedTools.flatMap((tool) => {
    const guidance = Array.isArray(tool.guidance) ? tool.guidance : [];
    return [`- ${tool.id}: ${tool.summary}`, ...guidance.map((item) => `  - ${item}`)];
  });
  // Bare block — INJECT.md supplies the blank lines around the `{{EQUIPPED_TOOLS}}`
  // line (it sits on its own line, blank above and below), so the rendered Tools
  // section reads one blank line per gap.
  return `Equipped tools (installed via /equip) — mandatory first-pass capabilities. These are live MCP tools available in this session; call them directly before using manual search/read. Use the live MCP tools in the mcp__codebase_memory_mcp namespace:\n${lines.join('\n')}`;
}

export function renderInject({ pluginRoot, projectDir, sessionId, asOwner, kbEnabled = true, equippedTools }) {
  const raw = readFileSync(join(pluginRoot, 'INJECT.md'), 'utf-8');
  const kbScoped = kbEnabled ? raw : stripKbOnly(raw);
  const base = asOwner ? kbScoped : stripOwnerOnly(kbScoped);
  const projectRoot = projectDir ? coralProjectDir(projectDir) : undefined;
  // Trailing slash matches skill-vars / agent path-alias conventions (`CORAL_METHODS/HOW-…`).
  const methodsRoot = `${join(pluginRoot, 'methods')}/`;
  return base
    .replaceAll('{{CORAL_KB}}', resolveKbRoot())
    .replaceAll('{{CORAL_CLI}}', activeBridgeCommand(pluginRoot))
    .replaceAll('{{CORAL_METHODS}}', methodsRoot)
    .replaceAll('{{EQUIPPED_TOOLS}}', renderEquippedTools(equippedTools))
    .replaceAll('{{SESSION_ID}}', sessionId || '')
    // Singular alias used by skills/agents; plural kept for older inject copy.
    .replaceAll('{{CORAL_PROJECT}}', projectRoot ?? '{{CORAL_PROJECT}}')
    .replaceAll('{{CORAL_PROJECTS}}', projectRoot ?? '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}');
}
