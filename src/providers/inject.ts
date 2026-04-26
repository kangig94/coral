import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kbRoot } from "../kb/paths.js";
import { projectDataDir, resolveProjectSource } from "../infra/project-source.js";
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { isOwnerId } from '../infra/identifiers.js';

declare const __PLUGIN_ROOT__: string;

export interface ResolveInjectMdOptions {
  workingDirectory?: string;
  ownerSessionId?: string;
  /** CORAL_* env snapshot. Source for CORAL_KB_PATH override. */
  coralEnv?: Record<string, string>;
}

let injectMdCache: string | undefined;

function pluginRoot(): string {
  if (typeof __PLUGIN_ROOT__ !== 'string') {
    throw new Error('Provider INJECT.md resolver requires __PLUGIN_ROOT__ to be defined at build time.');
  }
  return __PLUGIN_ROOT__;
}

function getInjectMd(): string {
  if (injectMdCache !== undefined) return injectMdCache;

  try {
    injectMdCache = readFileSync(join(pluginRoot(), 'INJECT.md'), 'utf-8');
  } catch {
    injectMdCache = '';
  }

  return injectMdCache;
}

function stripSessionIdOnly(text: string): string {
  return text.replace(/<!-- SESSION_ID_ONLY:BEGIN -->[\s\S]*?<!-- SESSION_ID_ONLY:END -->\n?/g, '');
}

function stripOwnerOnly(text: string): string {
  return text.replace(/<!-- OWNER_ONLY:BEGIN -->[\s\S]*?<!-- OWNER_ONLY:END -->\n?/g, '');
}

export function resolveInjectMd(opts: ResolveInjectMdOptions = {}): string {
  const md = getInjectMd();
  if (!md) return '';

  const { workingDirectory, ownerSessionId, coralEnv } = opts;
  const normalizedOwner = isOwnerId(ownerSessionId) ? ownerSessionId : undefined;
  const cliPath = `node "${join(pluginRoot(), 'bridge', 'coral-cli.cjs')}"`;
  const flavor = resolveBuildFlavor(coralEnv ?? process.env);
  const rendered = md
    .replaceAll('{{CORAL_KB}}', kbRoot(flavor, coralEnv?.CORAL_KB_PATH))
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{SESSION_ID}}', normalizedOwner ?? '')
    .replaceAll('{{CORAL_PROJECTS}}', workingDirectory ? projectDataDir(workingDirectory) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', workingDirectory ? resolveProjectSource(workingDirectory) : '{{PROJECT_SOURCE}}');
  const withoutOwner = stripOwnerOnly(rendered);
  return normalizedOwner ? withoutOwner : stripSessionIdOnly(withoutOwner);
}
