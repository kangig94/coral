#!/usr/bin/env node

import { join } from 'node:path';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, coralProjectDir } from './lib/hook-utils.mjs';
import { CORAL_SKILL_MESSAGE_RE, CORAL_SKILL_FIELD_PREFIX_RE } from './lib/coral-skills.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;

  if (!pluginRoot || !projectDir) process.exit(0);

  let matched = false;

  if (event === 'UserPromptSubmit') {
    const message = input.user_message || input.message || input.prompt || '';
    matched = CORAL_SKILL_MESSAGE_RE.test(message);
  } else if (event === 'PreToolUse') {
    const skill = input.tool_input?.skill || '';
    matched = CORAL_SKILL_FIELD_PREFIX_RE.test(skill);
  }

  if (!matched) process.exit(0);

  const context = [
    `CORAL_PROJECT: ${coralProjectDir(projectDir)}`,
    `CORAL_METHODS: ${join(pluginRoot, 'methods')}/`,
  ].join('\n');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `Coral skill path variables — substitute these for the named placeholders in the skill body:\n${context}`,
    },
  }));
} catch {
  process.exit(0);
}
