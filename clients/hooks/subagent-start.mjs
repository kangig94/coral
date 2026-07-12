#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolveEquippedTools } from './lib/equip-tools.mjs';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';
import { renderInject } from './lib/inject-render.mjs';
import { isKbEnabled } from './lib/kb-toggle.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;

  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT)) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const injectContent = renderInject({
    pluginRoot: PLUGIN_ROOT,
    projectDir,
    sessionId,
    asOwner: false,
    kbEnabled: isKbEnabled(),
    equippedTools: resolveEquippedTools(),
  });

  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: injectContent },
    }),
  );
} catch {
  process.exit(0);
}
