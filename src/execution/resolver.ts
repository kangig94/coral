import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { stripMdExt } from '../kb/paths.js';
import { isNoEntryError } from '../shared/mcp-utils.js';

declare const __PLUGIN_ROOT__: string;
const pluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..');

export type CoralContent =
  | { type: 'agent'; content: string; path: string }
  | { type: 'skill'; content: string; path: string };

export interface AgentMeta {
  model?: string;
}

export function parseAgentMeta(content: string): AgentMeta {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return {};

  const fm = fmMatch[1];
  const meta: AgentMeta = {};

  const modelMatch = fm.match(/^model:\s*(.+)$/m);
  if (modelMatch) meta.model = modelMatch[1].trim();

  return meta;
}

export function resolveCoralContent(name: string): CoralContent {
  const normalized = stripMdExt(name);
  if (!isValidName(normalized)) {
    throw new Error(`Invalid coral target name: ${name}`);
  }

  const agentsDir = join(pluginRoot, 'agents');
  const agentPath = resolve(agentsDir, `${normalized}.md`);
  ensureContained(agentsDir, agentPath);
  const agentContent = readFileIfExists(agentPath);
  if (agentContent !== null) {
    return { type: 'agent', content: agentContent, path: agentPath };
  }

  const skillsDir = join(pluginRoot, 'skills');
  const skillPath = resolve(skillsDir, normalized, 'SKILL.md');
  ensureContained(skillsDir, skillPath);
  const skillContent = readFileIfExists(skillPath);
  if (skillContent !== null) {
    return { type: 'skill', content: skillContent, path: skillPath };
  }

  throw new Error(
    `Coral content not found: ${normalized} (expected agents/${normalized}.md or skills/${normalized}/SKILL.md)`,
  );
}

export function stripAgentMetadata(content: string): string {
  const withoutFrontmatter = content.replace(/^---\r?\n([\s\S]*?\r?\n)?---\r?\n?/, '');
  return withoutFrontmatter
    .split(/\r?\n/)
    .filter((line) => !/^\s*>\s*\*\*CORAL_[A-Z0-9_]+.*$/.test(line))
    .join('\n')
    .trim();
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function ensureContained(rootDir: string, targetPath: string): void {
  if (!targetPath.startsWith(`${rootDir}${sep}`)) {
    throw new Error('Invalid coral path');
  }
}

function readFileIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err: unknown) {
    if (isNoEntryError(err)) return null;
    throw err;
  }
}
