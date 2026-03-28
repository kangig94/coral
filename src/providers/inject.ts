import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kbRoot, projectDataDir, resolveProjectSource } from '../infra/paths.js';
import { isOwnerId } from '../shared/mcp-utils.js';

declare const __PLUGIN_ROOT__: string;
const pluginRoot: string = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : join(__dirname, '..');
let injectMdCache: string | undefined;

function getInjectMd(): string {
  if (injectMdCache !== undefined) return injectMdCache;

  try {
    injectMdCache = readFileSync(join(pluginRoot, 'INJECT.md'), 'utf-8');
  } catch {
    injectMdCache = '';
  }

  return injectMdCache;
}

function stripOwnerOnlyBlock(text: string): string {
  return text.replace(/<!-- SESSION_ID_ONLY:BEGIN -->[\s\S]*?<!-- SESSION_ID_ONLY:END -->\n?/g, '');
}

export function resolveInjectMd(workingDirectory?: string, ownerSessionId?: string): string {
  const md = getInjectMd();
  if (!md) return '';

  const normalizedOwner = isOwnerId(ownerSessionId) ? ownerSessionId : undefined;
  const cliPath = `node "${join(pluginRoot, 'bridge', 'coral-cli.cjs')}"`;
  const rendered = md
    .replaceAll('{{CORAL_KB}}', kbRoot())
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{SESSION_ID}}', normalizedOwner || '')
    .replaceAll('{{CORAL_PROJECTS}}', workingDirectory ? projectDataDir(workingDirectory) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', workingDirectory ? resolveProjectSource(workingDirectory) : '{{PROJECT_SOURCE}}');
  return normalizedOwner ? rendered : stripOwnerOnlyBlock(rendered);
}
