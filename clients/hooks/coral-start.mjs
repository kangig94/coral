#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fitAdditionalContext } from './lib/additional-context.mjs';
import { resolveEquippedTools } from './lib/equip-tools.mjs';
import {
  exitIfChildProcess,
  exitIfWrongFlavor,
  isValidSessionId,
  readStdin,
  writeHookOutput,
} from './lib/hook-utils.mjs';
import { renderInject } from './lib/inject-render.mjs';

exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!isValidSessionId(sessionId)) process.exit(0);

  const hookEventName = input.hook_event_name;
  if (hookEventName !== 'SessionStart' && hookEventName !== 'SubagentStart') process.exit(0);

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
  if (!pluginRoot || !existsSync(pluginRoot)) process.exit(0);

  const injectContent = renderInject({
    pluginRoot,
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    sessionId,
    asOwner: hookEventName === 'SessionStart',
    group: 'coral',
    equippedTools: resolveEquippedTools(),
  });
  const additionalContext = fitAdditionalContext({ fixedContent: injectContent });

  writeHookOutput({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
} catch {
  process.exit(0);
}
