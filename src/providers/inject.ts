import { join } from 'node:path';
import { isOwnerId } from '../infra/identifiers.js';
import type { StoragePort } from '../infra/port-types.js';

declare const __PLUGIN_ROOT__: string;

export interface InjectEquippedTool {
  readonly id: string;
  readonly summary: string;
  readonly guidance?: readonly string[];
}

export interface ResolveInjectMdOptions {
  storage: Pick<StoragePort, 'readFileSync'>;
  ownerSessionId?: string;
  /** Resolved KB markdown root — caller passes from `runtime.paths.coral.corpus.kbRoot`. */
  kbRoot: string;
  /** Resolved per-project data dir — caller passes from `runtime.paths.projectData(cwd)`; absent when no cwd. */
  coralProjects?: string;
  /** Resolved project source — caller passes from `runtime.paths.projectSource(cwd)`; absent when no cwd. */
  projectSource?: string;
  /** When false, strip the KB_ONLY block so no KB guidance reaches the provider. */
  kbEnabled?: boolean;
  equippedTools?: readonly InjectEquippedTool[];
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

function stripKbOnly(text: string): string {
  return text.replace(/<!-- KB_ONLY:BEGIN -->[\s\S]*?<!-- KB_ONLY:END -->\n?/g, '');
}

function renderEquippedTools(equippedTools: readonly InjectEquippedTool[] | undefined): string {
  if (!equippedTools || equippedTools.length === 0) {
    return '';
  }

  const lines = equippedTools.flatMap((tool) => [
    `- ${tool.id}: ${tool.summary}`,
    ...(tool.guidance ?? []).map((item) => `  - ${item}`),
  ]);
  return `Equipped tools (installed via /equip) — mandatory first-pass capabilities. These are live MCP tools available in this session; call them directly before using manual search/read. Use the live MCP tools in the mcp__codebase_memory_mcp namespace:\n${lines.join('\n')}`;
}

export function resolveInjectMd(opts: ResolveInjectMdOptions): string {
  const md = getInjectMd(opts.storage);
  if (!md) return '';

  const { ownerSessionId, kbRoot, coralProjects, projectSource } = opts;
  const normalizedOwner = isOwnerId(ownerSessionId) ? ownerSessionId : undefined;
  const cliPath = `node "${join(pluginRoot(), 'bridge', 'coral-cli.cjs')}"`;
  const base = opts.kbEnabled === false ? stripKbOnly(md) : md;
  const rendered = base
    .replaceAll('{{CORAL_KB}}', kbRoot)
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{EQUIPPED_TOOLS}}', renderEquippedTools(opts.equippedTools))
    .replaceAll('{{SESSION_ID}}', normalizedOwner ?? '')
    .replaceAll('{{CORAL_PROJECTS}}', coralProjects ?? '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectSource ?? '{{PROJECT_SOURCE}}');
  const withoutOwner = stripOwnerOnly(rendered);
  return normalizedOwner ? withoutOwner : stripSessionIdOnly(withoutOwner);
}
