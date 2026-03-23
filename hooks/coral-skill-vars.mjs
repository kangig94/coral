#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const CORAL_SKILLS = /\/(?:coral:)?(?:plan|preplan|analyze|ralph|bid|discuss|init-project|bugfix|code-simplify)\b/;

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;

  if (!pluginRoot || !projectDir) process.exit(0);

  let matched = false;

  if (event === 'UserPromptSubmit') {
    const message = input.user_message || input.message || input.prompt || '';
    matched = CORAL_SKILLS.test(message);
  } else if (event === 'PreToolUse') {
    const skill = input.tool_input?.skill || '';
    matched = /^coral:/.test(skill);
  }

  if (!matched) process.exit(0);

  const context = [
    `CORAL_PROJECT: ${coralProjectDir(projectDir)}`,
    `CORAL_AGENTS: ${join(pluginRoot, 'agents')}/`,
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

function resolveProjectSource(projectDir) {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().replace(/\.git$/, '');
    const sshPath = remote.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
    const rawPath = sshPath ?? remote.replace(/^[^:]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/^[^/]+\/+/, '');
    const segments = rawPath.split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments.at(-2)}/${segments.at(-1)}`;
  } catch {
    // fall through
  }
  return `local/${basename(projectDir)}`;
}

function coralProjectDir(projectDir) {
  return join(homedir(), '.coral', 'projects', resolveProjectSource(projectDir).replace(/\//g, '-'));
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
