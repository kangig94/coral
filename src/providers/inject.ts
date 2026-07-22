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

export interface ResolveInjectBundleOptions {
  storage: Pick<StoragePort, 'readFileSync'>;
  ownerSessionId?: string;
  /** Resolved KB markdown root — caller passes from `runtime.paths.coral.corpus.kbRoot`. */
  kbRoot: string;
  /** Resolved per-project data dir — caller passes from `runtime.paths.projectData(cwd)`; absent when no cwd. */
  coralProjects?: string;
  /** Resolved project source — caller passes from `runtime.paths.projectSource(cwd)`; absent when no cwd. */
  projectSource?: string;
  /** When false, omit all KB fragments so no KB guidance reaches the provider. */
  kbEnabled?: boolean;
  equippedTools?: readonly InjectEquippedTool[];
}

const BASE_INJECT_FRAGMENTS = ['core.md', 'tools.md'] as const;
const KB_COMMON_INJECT_FRAGMENT = 'kb/common.md';
const KB_SESSION_INJECT_FRAGMENT = 'kb/session.md';

const injectFragmentCache = new Map<string, string>();

function pluginRoot(): string {
  if (typeof __PLUGIN_ROOT__ !== 'string') {
    throw new Error('Provider inject bundle resolver requires __PLUGIN_ROOT__ to be defined at build time.');
  }
  return __PLUGIN_ROOT__;
}

function readInjectFragment(storage: Pick<StoragePort, 'readFileSync'>, relativePath: string): string {
  const cached = injectFragmentCache.get(relativePath);
  if (cached !== undefined) return cached;

  const fragment = storage.readFileSync(join(pluginRoot(), 'inject', relativePath), 'utf-8').trimEnd();
  injectFragmentCache.set(relativePath, fragment);
  return fragment;
}

function readInjectBundle(
  storage: Pick<StoragePort, 'readFileSync'>,
  options: { kbEnabled: boolean; hasSession: boolean },
): string {
  const paths: string[] = [...BASE_INJECT_FRAGMENTS];
  if (options.kbEnabled) {
    paths.push(KB_COMMON_INJECT_FRAGMENT);
    if (options.hasSession) paths.push(KB_SESSION_INJECT_FRAGMENT);
  }

  try {
    return paths
      .map((path) => readInjectFragment(storage, path))
      .filter((fragment) => fragment.length > 0)
      .join('\n\n');
  } catch {
    return '';
  }
}

function renderEquippedTools(equippedTools: readonly InjectEquippedTool[] | undefined): string {
  if (!equippedTools || equippedTools.length === 0) {
    return '';
  }

  const lines = equippedTools.flatMap((tool) => [
    `- ${tool.id}: ${tool.summary}`,
    ...(tool.guidance ?? []).map((item) => `  - ${item}`),
  ]);
  return [
    '⚠ Equipped tools are capabilities the user explicitly installed via /equip to improve your work.',
    'You MUST use every applicable equipped tool as the highest-priority first pass, before built-in tools or manual alternatives:',
    ...lines,
  ].join('\n');
}

export function resolveInjectBundle(opts: ResolveInjectBundleOptions): string {
  const { ownerSessionId, kbRoot, coralProjects, projectSource } = opts;
  const normalizedOwner = isOwnerId(ownerSessionId) ? ownerSessionId : undefined;
  const bundle = readInjectBundle(opts.storage, {
    kbEnabled: opts.kbEnabled !== false,
    hasSession: normalizedOwner !== undefined,
  });
  if (!bundle) return '';

  const root = pluginRoot();
  const cliPath = `node "${join(root, 'bridge', 'coral-cli.cjs')}"`;
  // Trailing slash matches skill-vars / agent path-alias conventions (`CORAL_METHODS/HOW-…`).
  const methodsRoot = `${join(root, 'methods')}/`;
  return (
    bundle
      .replaceAll('{{CORAL_KB}}', kbRoot)
      .replaceAll('{{CORAL_CLI}}', cliPath)
      .replaceAll('{{CORAL_METHODS}}', methodsRoot)
      .replaceAll('{{EQUIPPED_TOOLS}}', renderEquippedTools(opts.equippedTools))
      .replaceAll('{{SESSION_ID}}', normalizedOwner ?? '')
      // Singular alias used by skills/agents; plural kept for older inject copy.
      .replaceAll('{{CORAL_PROJECT}}', coralProjects ?? '{{CORAL_PROJECT}}')
      .replaceAll('{{CORAL_PROJECTS}}', coralProjects ?? '{{CORAL_PROJECTS}}')
      .replaceAll('{{PROJECT_SOURCE}}', projectSource ?? '{{PROJECT_SOURCE}}')
  );
}

/**
 * Provider-agnostic inject bundle application.
 *
 * Prepends rendered guidelines onto `request.systemPrompt` (append-merge when a
 * caller systemPrompt already exists — never overwrite). Empty inject is a no-op.
 * Applied once at the job shell boundary before any provider adapter runs so
 * Built-in and future providers share the same injection policy.
 */
export function applyInjectBundle(
  request: ProviderRequest,
  runtime: {
    storage: Pick<StoragePort, 'readFileSync'>;
    kbRoot: string;
    coralProjects?: string;
    projectSource?: string;
    equippedTools?: readonly InjectEquippedTool[];
  },
): ProviderRequest {
  const injectBundle = resolveInjectBundle({
    storage: runtime.storage,
    ownerSessionId: request.coralEnv?.CORAL_OWNER,
    kbRoot: runtime.kbRoot,
    kbEnabled: resolveKbEnabled(request.coralEnv?.[CORAL_KB_ENABLE_ENV]),
    ...(runtime.coralProjects === undefined ? {} : { coralProjects: runtime.coralProjects }),
    ...(runtime.projectSource === undefined ? {} : { projectSource: runtime.projectSource }),
    ...(runtime.equippedTools === undefined ? {} : { equippedTools: runtime.equippedTools }),
  });
  if (!injectBundle) {
    return request;
  }

  const systemPrompt = request.systemPrompt ? `${injectBundle}\n\n${request.systemPrompt}` : injectBundle;
  return { ...request, systemPrompt };
}
