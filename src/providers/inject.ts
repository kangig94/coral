import { join } from 'node:path';
import { projectDataDir, resolveProjectSource } from '../infra/project-source.js';
import { isOwnerId } from '../infra/identifiers.js';
import type { StoragePort } from '../infra/port-types.js';

declare const __PLUGIN_ROOT__: string;

export interface ResolveInjectMdOptions {
  storage: Pick<StoragePort, 'readFileSync'>;
  workingDirectory?: string;
  ownerSessionId?: string;
  /** Resolved KB markdown root — caller passes from `runtime.paths.coral.corpus.kbRoot`. */
  kbRoot: string;
}

let injectMdCache: string | undefined;

function pluginRoot(): string {
  if (typeof __PLUGIN_ROOT__ !== 'string') {
    throw new Error('Provider INJECT.md resolver requires __PLUGIN_ROOT__ to be defined at build time.');
  }
  return __PLUGIN_ROOT__;
}

function getInjectMd(storage: Pick<StoragePort, 'readFileSync'>): string {
  if (injectMdCache !== undefined) return injectMdCache;

  try {
    injectMdCache = storage.readFileSync(join(pluginRoot(), 'INJECT.md'), 'utf-8');
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

export function resolveInjectMd(opts: ResolveInjectMdOptions): string {
  const md = getInjectMd(opts.storage);
  if (!md) return '';

  const { workingDirectory, ownerSessionId, kbRoot } = opts;
  const normalizedOwner = isOwnerId(ownerSessionId) ? ownerSessionId : undefined;
  const cliPath = `node "${join(pluginRoot(), 'bridge', 'coral-cli.cjs')}"`;
  const rendered = md
    .replaceAll('{{CORAL_KB}}', kbRoot)
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{SESSION_ID}}', normalizedOwner ?? '')
    .replaceAll('{{CORAL_PROJECTS}}', workingDirectory ? projectDataDir(workingDirectory) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', workingDirectory ? resolveProjectSource(workingDirectory) : '{{PROJECT_SOURCE}}');
  const withoutOwner = stripOwnerOnly(rendered);
  return normalizedOwner ? withoutOwner : stripSessionIdOnly(withoutOwner);
}
