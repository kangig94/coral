#!/usr/bin/env node

/**
 * SubagentStart hook — detects codex-* agents and injects delegation instructions.
 * Also ensures ~/.codex/config.toml has multi_agent = true.
 * Fail-open: any error exits silently.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try {
  const input = JSON.parse(await readStdin());
  const agentName = input.agent_name || input.name || '';
  if (!agentName) process.exit(0);

  // Check for "codex-" prefix (case-insensitive, with optional namespace)
  if (!/(^|:)codex-/i.test(agentName)) process.exit(0);

  // Ensure multi_agent feature is enabled in Codex config
  ensureMultiAgent();

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: 'Codex delegation context: You are a Codex delegation agent. You MUST use the appropriate Codex MCP tool (`codex({ op: "exec", ... })`) to forward ALL work to Codex CLI. Do NOT generate your own response in place of calling Codex. Call the MCP tool immediately with the full task.',
    },
  }));
} catch {
  process.exit(0);
}

function ensureMultiAgent() {
  const configPath = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(configPath)) {
    mkdirSync(join(homedir(), '.codex'), { recursive: true });
    writeFileSync(configPath, '[features]\nmulti_agent = true\n');
    return;
  }

  const content = readFileSync(configPath, 'utf8');
  if (/multi_agent\s*=\s*true/.test(content)) return;

  // Remove existing multi_agent line, add correct one
  const lines = content.split('\n').filter(l => !l.includes('multi_agent'));
  const featIdx = lines.findIndex(l => /^\[features\]/.test(l));
  if (featIdx >= 0) {
    lines.splice(featIdx + 1, 0, 'multi_agent = true');
  } else {
    lines.push('', '[features]', 'multi_agent = true');
  }
  writeFileSync(configPath, lines.join('\n'));
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
