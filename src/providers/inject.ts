import { join } from 'node:path';
import { isOwnerId } from '../infra/identifiers.js';
import { CORAL_KB_ENABLE_ENV, resolveKbEnabled } from '../infra/kb-toggle.js';
import type { StoragePort } from '../infra/port-types.js';
import type { ProviderRequest } from './contract.js';

declare const __PLUGIN_ROOT__: string;

interface InjectEquippedTool {
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
  return `Equipped tools (installed via /equip):\n${lines.join('\n')}`;
}

export function resolveInjectMd(opts: ResolveInjectMdOptions): string {
  const md = getInjectMd(opts.storage);
  if (!md) return '';

  const { ownerSessionId, kbRoot, coralProjects, projectSource } = opts;
  const normalizedOwner = isOwnerId(ownerSessionId) ? ownerSessionId : undefined;
  const root = pluginRoot();
  const cliPath = `node "${join(root, 'bridge', 'coral-cli.cjs')}"`;
  // Trailing slash matches skill-vars / agent path-alias conventions (`CORAL_METHODS/HOW-…`).
  const methodsRoot = `${join(root, 'methods')}/`;
  const base = opts.kbEnabled === false ? stripKbOnly(md) : md;
  const rendered = base
    .replaceAll('{{CORAL_KB}}', kbRoot)
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{CORAL_METHODS}}', methodsRoot)
    .replaceAll('{{EQUIPPED_TOOLS}}', renderEquippedTools(opts.equippedTools))
    .replaceAll('{{SESSION_ID}}', normalizedOwner ?? '')
    // Singular alias used by skills/agents; plural kept for older inject copy.
    .replaceAll('{{CORAL_PROJECT}}', coralProjects ?? '{{CORAL_PROJECT}}')
    .replaceAll('{{CORAL_PROJECTS}}', coralProjects ?? '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectSource ?? '{{PROJECT_SOURCE}}');
  const withoutOwner = stripOwnerOnly(rendered);
  return normalizedOwner ? withoutOwner : stripSessionIdOnly(withoutOwner);
}

/**
 * Provider-agnostic INJECT.md application.
 *
 * Prepends rendered guidelines onto `request.systemPrompt` (append-merge when a
 * caller systemPrompt already exists — never overwrite). Empty inject is a no-op.
 * Applied once at the job shell boundary before any provider adapter runs so
 * Claude and Codex (and future providers) share the same injection policy.
 */
export function applyInjectMd(
  request: ProviderRequest,
  runtime: {
    storage: Pick<StoragePort, 'readFileSync'>;
    kbRoot: string;
    coralProjects?: string;
    projectSource?: string;
    equippedTools?: readonly InjectEquippedTool[];
  },
): ProviderRequest {
  const injectMd = resolveInjectMd({
    storage: runtime.storage,
    ownerSessionId: request.coralEnv?.CORAL_OWNER,
    kbRoot: runtime.kbRoot,
    kbEnabled: resolveKbEnabled(request.coralEnv?.[CORAL_KB_ENABLE_ENV]),
    ...(runtime.coralProjects === undefined ? {} : { coralProjects: runtime.coralProjects }),
    ...(runtime.projectSource === undefined ? {} : { projectSource: runtime.projectSource }),
    ...(runtime.equippedTools === undefined ? {} : { equippedTools: runtime.equippedTools }),
  });
  if (!injectMd) {
    return request;
  }

  const systemPrompt = request.systemPrompt ? `${injectMd}\n\n${request.systemPrompt}` : injectMd;
  return { ...request, systemPrompt };
}
