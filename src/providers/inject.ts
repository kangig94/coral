import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kbRoot, projectDataDir, resolveProjectSource } from '../client/paths.js';

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

export function resolveInjectMd(workingDirectory?: string): string {
  const md = getInjectMd();
  if (!md) return '';

  const cliPath = `node "${join(pluginRoot, 'bridge', 'coral-cli.cjs')}"`;
  return md
    .replaceAll('{{CORAL_KB}}', kbRoot())
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{CORAL_PROJECTS}}', workingDirectory ? projectDataDir(workingDirectory) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', workingDirectory ? resolveProjectSource(workingDirectory) : '{{PROJECT_SOURCE}}');
}
