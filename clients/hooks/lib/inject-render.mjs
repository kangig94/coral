// Renders the inject fragment bundle into additionalContext for
// session-start and subagent-start hooks.
//
// Contract:
//   - SessionStart: asOwner=true — include orchestrator privileges like
//     workflow owner propagation and source management.
//   - SubagentStart: asOwner=false — omit orchestrator privileges, but include
//     session guidance since subagents share the parent's session_id and can
//     write memos under the same owner scope.
//   - {{EQUIPPED_TOOLS}}: rendered only when the caller passes `equippedTools`
//     (session-start and subagent-start do). The placeholder is stripped
//     otherwise.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coralProjectDir, resolveKbRoot, resolveProjectSource } from './hook-utils.mjs';
import { activeBridgeCommand } from './plugin-paths.mjs';

const BASE_INJECT_FRAGMENTS = ['core.md', 'tools.md'];
const KB_COMMON_INJECT_FRAGMENT = 'kb/common.md';
const KB_ORCHESTRATOR_INJECT_FRAGMENT = 'kb/orchestrator.md';
const KB_SESSION_INJECT_FRAGMENT = 'kb/session.md';

function readInjectBundle(pluginRoot, { asOwner, kbEnabled }) {
  const paths = [...BASE_INJECT_FRAGMENTS];
  if (kbEnabled) {
    paths.push(KB_COMMON_INJECT_FRAGMENT);
    if (asOwner) paths.push(KB_ORCHESTRATOR_INJECT_FRAGMENT);
    paths.push(KB_SESSION_INJECT_FRAGMENT);
  }
  return paths
    .map((path) => readFileSync(join(pluginRoot, 'inject', path), 'utf-8').trimEnd())
    .filter(Boolean)
    .join('\n\n');
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
  // Bare block — tools.md supplies the blank lines around the `{{EQUIPPED_TOOLS}}`
  // line (it sits on its own line, blank above and below), so the rendered Tools
  // section reads one blank line per gap.
  return `Equipped tools (installed via /equip):\n${lines.join('\n')}`;
}

export function renderInject({ pluginRoot, projectDir, sessionId, asOwner, kbEnabled = true, equippedTools }) {
  const bundle = readInjectBundle(pluginRoot, { asOwner, kbEnabled });
  const projectRoot = projectDir ? coralProjectDir(projectDir) : undefined;
  // Trailing slash matches skill-vars / agent path-alias conventions (`CORAL_METHODS/HOW-…`).
  const methodsRoot = `${join(pluginRoot, 'methods')}/`;
  return (
    bundle
      .replaceAll('{{CORAL_KB}}', resolveKbRoot())
      .replaceAll('{{CORAL_CLI}}', activeBridgeCommand(pluginRoot))
      .replaceAll('{{CORAL_METHODS}}', methodsRoot)
      .replaceAll('{{EQUIPPED_TOOLS}}', renderEquippedTools(equippedTools))
      .replaceAll('{{SESSION_ID}}', sessionId || '')
      // Singular alias used by skills/agents; plural kept for older inject copy.
      .replaceAll('{{CORAL_PROJECT}}', projectRoot ?? '{{CORAL_PROJECT}}')
      .replaceAll('{{CORAL_PROJECTS}}', projectRoot ?? '{{CORAL_PROJECTS}}')
      .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}')
  );
}
