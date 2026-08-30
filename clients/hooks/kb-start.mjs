#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  exitIfChildProcess,
  exitIfWrongFlavor,
  isValidSessionId,
  readStdin,
  resolveKbRoot,
  resolveProjectSource,
  writeHookOutput,
} from './lib/hook-utils.mjs';
import { fitAdditionalContext } from './lib/additional-context.mjs';
import { renderInject } from './lib/inject-render.mjs';
import { isKbEnabled } from './lib/kb-toggle.mjs';
import { readProjectScopedWakeUp } from './lib/wake-up-read.mjs';

exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!isValidSessionId(sessionId)) process.exit(0);

  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT) || !isKbEnabled()) process.exit(0);

  const hookEventName = input.hook_event_name;
  if (hookEventName !== 'SessionStart' && hookEventName !== 'SubagentStart') process.exit(0);
  const asOwner = hookEventName === 'SessionStart';
  let additionalContext;
  try {
    const injectContent = renderInject({
      pluginRoot: PLUGIN_ROOT,
      projectDir: asOwner ? projectDir : undefined,
      sessionId,
      asOwner,
      group: 'kb',
    });
    const kbRoot = resolveKbRoot();
    const projectSlug = asOwner && projectDir ? resolveProjectSource(projectDir).replace(/\//g, '-') : undefined;
    const wakeUpPayload = projectSlug ? readProjectScopedWakeUp(kbRoot, projectSlug) : null;
    additionalContext = fitAdditionalContext({
      fixedContent: injectContent,
      variableContent: wakeUpPayload,
      trimNotice: projectSlug
        ? `Coral project wiki wake-up was trimmed to fit this hook payload; read the full ## Understanding section at \`${join(kbRoot, 'wiki', `${projectSlug}.md`)}\`.`
        : '',
    });
  } catch {
    additionalContext =
      `Coral KB contract could not be rendered; read \`${PLUGIN_ROOT}/inject/kb/*.md\` from the active Coral plugin.`;
  }

  writeHookOutput({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
} catch {
  process.exit(0);
}
