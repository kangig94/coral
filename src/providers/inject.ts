import { join } from 'node:path';
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
  /** Resolved per-project data dir; absent when no cwd. */
  coralProjects?: string;
  equippedTools?: readonly InjectEquippedTool[];
}

// A provider child is told nothing about the Coral CLI or the KB: it has no hook to resolve
// `coral-cli`, and CLI or KB work belongs to the top-level session.
const PROVIDER_INJECT_FRAGMENTS = ['core.md', 'tools.md'] as const;

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

function readInjectBundle(storage: Pick<StoragePort, 'readFileSync'>): string {
  try {
    return PROVIDER_INJECT_FRAGMENTS.map((path) => readInjectFragment(storage, path))
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
  const bundle = readInjectBundle(opts.storage);
  if (!bundle) return '';

  // Trailing slash matches skill-vars / agent path-alias conventions (`CORAL_METHODS/HOW-…`).
  const methodsRoot = `${join(pluginRoot(), 'methods')}/`;
  return bundle
    .replaceAll('{{CORAL_METHODS}}', methodsRoot)
    .replaceAll('{{EQUIPPED_TOOLS}}', renderEquippedTools(opts.equippedTools))
    .replaceAll('{{CORAL_PROJECT}}', opts.coralProjects ?? '{{CORAL_PROJECT}}');
}

/**
 * Append-merge when a caller systemPrompt already exists — never overwrite.
 * Applied once at the job shell boundary before any provider adapter runs so
 * Built-in and future providers share the same injection policy.
 */
export function applyInjectBundle(
  request: ProviderRequest,
  runtime: {
    storage: Pick<StoragePort, 'readFileSync'>;
    coralProjects?: string;
    equippedTools?: readonly InjectEquippedTool[];
  },
): ProviderRequest {
  const injectBundle = resolveInjectBundle({
    storage: runtime.storage,
    ...(runtime.coralProjects === undefined ? {} : { coralProjects: runtime.coralProjects }),
    ...(runtime.equippedTools === undefined ? {} : { equippedTools: runtime.equippedTools }),
  });
  if (!injectBundle) {
    return request;
  }

  const systemPrompt = request.systemPrompt ? `${injectBundle}\n\n${request.systemPrompt}` : injectBundle;
  return { ...request, systemPrompt };
}
