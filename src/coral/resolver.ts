import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isNoEntryError } from '../shared/mcp-utils.js';

declare const __PLUGIN_ROOT__: string;
let pluginRoot: string = typeof __PLUGIN_ROOT__ === 'string'
  ? __PLUGIN_ROOT__
  : join(__dirname, '..');

export type CoralContent =
  | { type: 'agent'; content: string; path: string }
  | { type: 'skill'; content: string; path: string };

export function resolveCoralContent(name: string): CoralContent {
  if (!isValidName(name)) {
    throw new Error(`Invalid coral target name: ${name}`);
  }

  const agentsDir = join(pluginRoot, 'agents');
  const agentPath = resolve(agentsDir, `${name}.md`);
  ensureContained(agentsDir, agentPath);
  try {
    return { type: 'agent', content: readFileSync(agentPath, 'utf-8'), path: agentPath };
  } catch (err: unknown) {
    if (!isNoEntryError(err)) throw err;
  }

  const skillsDir = join(pluginRoot, 'skills');
  const skillPath = resolve(skillsDir, name, 'SKILL.md');
  ensureContained(skillsDir, skillPath);
  try {
    return { type: 'skill', content: readFileSync(skillPath, 'utf-8'), path: skillPath };
  } catch (err: unknown) {
    if (!isNoEntryError(err)) throw err;
  }

  throw new Error(`Coral content not found: ${name} (expected agents/${name}.md or skills/${name}/SKILL.md)`);
}

export function stripAgentMetadata(content: string): string {
  let stripped = content.replace(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/, '');
  stripped = stripped
    .split(/\r?\n/)
    .filter((line) => !/^\s*>\s*\*\*CORAL_[A-Z0-9_]+.*$/.test(line))
    .join('\n');
  return stripped.trim();
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name)
    && !name.includes('..')
    && !name.includes('/')
    && !name.includes('\\');
}

function ensureContained(rootDir: string, targetPath: string): void {
  if (!targetPath.startsWith(`${rootDir}${sep}`)) {
    throw new Error('Invalid coral path');
  }
}

export const _test = {
  setPluginRoot(p: string) { pluginRoot = p; },
};
