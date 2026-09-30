import { errorMessage } from '../../infra/error-format.js';
import type { AppServerTransport } from '../contract.js';
import {
  modelListEntrySchema,
  modelListResponseSchema,
  type AppServerRequestParams,
  type ModelListEntry,
} from './protocol.js';

const CODEX_SIZES = ['astra', 'sol', 'terra', 'luna'] as const;
export type CodexSize = (typeof CODEX_SIZES)[number];
const sizedModelPattern = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-(${CODEX_SIZES.join('|')})$`, 'i');
const MAX_CATALOG_PAGES = 100;

export type CodexModelCatalog =
  | Readonly<{
      kind: 'listed';
      newestBySize: Readonly<Partial<Record<CodexSize, string>>>;
      supportedEfforts: ReadonlyMap<string, readonly string[]>;
      skippedEntries: number;
    }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

export function isCodexSize(model: string): model is CodexSize {
  return CODEX_SIZES.some((size) => size === model);
}

/** Only a bare size or a numeric GPT version with a size suffix may split abstract tiers. */
export function isCodexSizedModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return isCodexSize(normalized) || sizedModelPattern.test(normalized);
}

function compareVersions(left: string, right: string): number {
  const leftSegments = left.split('.').map(Number);
  const rightSegments = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftSegments.length, rightSegments.length); index += 1) {
    const difference = (leftSegments[index] ?? 0) - (rightSegments[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function selectCatalog(
  models: ModelListEntry[],
  skippedEntries: number,
): Extract<CodexModelCatalog, { kind: 'listed' }> {
  const newestBySize: Partial<Record<CodexSize, string>> = {};
  const versions: Partial<Record<CodexSize, string>> = {};
  const supportedEfforts = new Map<string, readonly string[]>();
  for (const model of models) {
    supportedEfforts.set(
      model.model,
      model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    );
    if (model.hidden || model.upgrade !== null) continue;
    const match = sizedModelPattern.exec(model.model.trim());
    if (match === null) continue;
    const size = match[2].toLowerCase();
    if (!isCodexSize(size)) continue;
    const version = match[1];
    const previous = versions[size];
    if (previous === undefined || compareVersions(version, previous) > 0) {
      newestBySize[size] = model.model;
      versions[size] = version;
    }
  }
  return { kind: 'listed', newestBySize, supportedEfforts, skippedEntries };
}

function unavailable(reason: string): Extract<CodexModelCatalog, { kind: 'unavailable' }> {
  return { kind: 'unavailable', reason: reason.replace(/\s+/g, ' ').trim().slice(0, 200) };
}

/** A failed or incomplete catalog read must remain distinguishable from a listed catalog missing a size. */
export async function readCodexModelCatalog(transport: AppServerTransport): Promise<CodexModelCatalog> {
  const models: ModelListEntry[] = [];
  let skippedEntries = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const params: AppServerRequestParams<'model/list'> = { cursor, limit: 100, includeHidden: true };
    let response: unknown;
    try {
      response = await transport.rpc('model/list', params);
    } catch (error) {
      return unavailable(`model/list RPC failed: ${errorMessage(error)}`);
    }
    const parsed = modelListResponseSchema.safeParse(response);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      const first = issues[0];
      return unavailable(
        `Invalid model/list response: ${first.path.join('.') || 'response'}: ${first.message} (${issues.length} issues)`,
      );
    }
    for (const entry of parsed.data.data) {
      const parsedEntry = modelListEntrySchema.safeParse(entry);
      if (parsedEntry.success) models.push(parsedEntry.data);
      else skippedEntries += 1;
    }
    const nextCursor = parsed.data.nextCursor;
    if (nextCursor === null) return selectCatalog(models, skippedEntries);
    if (nextCursor === cursor) return unavailable(`model/list repeated cursor: ${nextCursor}`);
    cursor = nextCursor;
  }
  return unavailable(`model/list exceeded ${MAX_CATALOG_PAGES} pages`);
}
