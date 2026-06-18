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

export function renderInject({ pluginRoot, projectDir, sessionId, asOwner, kbEnabled = true }) {
  const raw = readFileSync(join(pluginRoot, 'INJECT.md'), 'utf-8');
  const kbScoped = kbEnabled ? raw : stripKbOnly(raw);
  const base = asOwner ? kbScoped : stripOwnerOnly(kbScoped);
  return base
    .replaceAll('{{CORAL_KB}}', resolveKbRoot())
    .replaceAll('{{CORAL_CLI}}', activeBridgeCommand(pluginRoot))
    .replaceAll('{{SESSION_ID}}', sessionId || '')
    .replaceAll('{{CORAL_PROJECTS}}', projectDir ? coralProjectDir(projectDir) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}');
}
