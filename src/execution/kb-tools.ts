import { join } from 'node:path';
import { kbRoot } from '../infra/paths.js';
import { createCurateScheduler, type CurateHandle } from '../kb/curate/scheduler.js';
import type { KbRuntime } from '../kb/contracts.js';
import type { GitSyncRuntimePicks } from '../kb/curate/types.js';
import { z } from 'zod';
import { deleteFn as kbDeleteFn } from '../kb/ops/delete.js';
import {
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseCommunityFrontmatter,
  parseFrontmatter,
  parseMembersFromBody,
  parseSourceFrontmatter,
  parseSummaryFromBody,
} from '../kb/frontmatter.js';
import { deleteMemos, listMemos, purgeMemos, writeMemo } from '../kb/ops/memo.js';
import {
  memoDir,
  kbRuntimeDir,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
  communityPathFromName,
} from '../kb/paths.js';
import { promote as kbPromote } from '../kb/ops/promote.js';
import { reindex as kbReindex } from '../kb/ops/reindex.js';
import { createKbRuntime } from '../kb/runtime.js';
import { searchKb } from '../kb/ops/search.js';
import { deleteSource, listSources, persistPreparedSource } from '../kb/ops/source-store.js';
import { isNoteEntry } from '../kb/types.js';
import { update as kbUpdate } from '../kb/ops/update.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, compareLocale } from '../kb/validation.js';
import {
  expandKbReadSelector,
  parseKbSelector,
  type KbReadKind,
  type KbResolvedReadSelector,
} from '../shared/kb-read-contract.js';
import { assertOwnerId } from '../shared/utils.js';
import type { CallerContext } from '../shared/request-context.js';
import type { SpawnCliFn } from './engine.js';
import type { Runtime } from './runtime.js';
import {
  deriveErrorMessage,
  domainError,
  domainSuccess,
  toolValidationError,
  type ToolDomainResult,
} from './tool-response.js';

export type KbSubsystem = {
  kb: KbRuntime;
  curateScheduler: CurateHandle;
};

export type CreateKbSubsystemOptions = {
  pluginRoot: string;
  spawnCli: SpawnCliFn;
} & GitSyncRuntimePicks;

export async function createKbSubsystem({
  pluginRoot,
  spawnCli: spawnKbCli,
  processPort,
  storagePort,
  envPort,
}: CreateKbSubsystemOptions): Promise<KbSubsystem> {
  const kb = createKbRuntime({
    markdownRoot: kbRoot(),
    runtimeDir: kbRuntimeDir(),
  });
  await kb.initVectorStore(pluginRoot);

  const curateScheduler = createCurateScheduler({
    kb,
    spawnCli: spawnKbCli,
    processPort,
    storagePort,
    envPort,
  });

  await curateScheduler.start();

  return {
    kb,
    curateScheduler,
  };
}

type KbArgs = Record<string, unknown>;
type KbToolRuntime = {
  storage: Pick<Runtime['storage'], 'existsSync' | 'readFileSync'>;
};

const kbSearchSchema = z
  .object({
    query: z.string().min(1),
    scope: z.enum(['notes', 'sources', 'communities', 'all']).optional(),
    top_k: z.number().int().positive().optional(),
  })
  .strict();

const kbReadSchema = z
  .object({
    note: z.string().min(1),
  })
  .strict();

const kbPromoteSchema = z
  .object({
    memo: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    domain: z.string().min(1),
    topic: z.string().min(1),
  })
  .strict();

const kbUpdateSchema = z
  .object({
    note: z.string().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
  })
  .strict();

const kbDeleteSchema = z
  .object({
    note: z.string().min(1),
  })
  .strict();

const kbSourceImportSchema = z
  .object({
    slug: z.string().min(1),
    stagedPath: z.string().min(1),
    meta: z
      .object({
        title: z.string(),
        type: z.string(),
        tags: z.array(z.string()),
        importedAt: z.string(),
      })
      .strict(),
  })
  .strict();

const kbSourceListSchema = z.object({}).strict();

const kbSourceDeleteSchema = z
  .object({
    slug: z.string().min(1),
  })
  .strict();

const kbReindexSchema = z.object({}).strict();

const kbMemoSchema = z
  .object({
    topic: z.string().min(1),
    content: z.string(),
    owner: z.string().min(1),
  })
  .strict();

const kbMemoListSchema = z
  .object({
    owner: z.string().optional(),
  })
  .strict();

const kbMemoDeleteSchema = z
  .object({
    pattern: z.string().min(1),
    owner: z.string().optional(),
  })
  .strict();

const kbMemoPurgeSchema = z
  .object({
    owner: z.string().optional(),
  })
  .strict();

const kbMemoDeleteConsolidatedSchema = z
  .object({
    pattern: z.string().min(1).optional(),
    owner: z.string().optional(),
    all: z.boolean().optional(),
  })
  .strict();

const kbPrinciplesSchema = z
  .object({
    query: z.string().optional(),
    verbose: z.boolean().optional(),
    top_k: z.number().int().positive().optional(),
  })
  .strict();

function kbErrorResult(error: unknown): ToolDomainResult {
  const detail = error instanceof Error ? { message: error.message } : error;
  return domainError('kb_error', deriveErrorMessage('kb_error', detail), detail);
}

async function runKbAction(action: () => Promise<unknown> | unknown): Promise<ToolDomainResult> {
  try {
    return domainSuccess(await action());
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

function runKbSyncAction(action: () => unknown): ToolDomainResult {
  try {
    return domainSuccess(action());
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

function invalidRequestResult(error: unknown): ToolDomainResult {
  return domainError('invalid_request', deriveErrorMessage('invalid_request', error));
}

function kbNotFoundResult(kind: KbReadKind, slug: string): ToolDomainResult {
  return domainError('not_found', `KB ${kind} not found: ${slug}`);
}

function normalizeKbSlug(
  slug: string,
  kind: KbReadKind,
): { ok: true; slug: string } | { ok: false; result: ToolDomainResult } {
  try {
    if (kind === 'community') {
      return { ok: true, slug: assertCommunitySlug(slug, kind) };
    }

    if (kind === 'source') {
      return { ok: true, slug: assertSourceSlug(slug, kind) };
    }

    return { ok: true, slug: assertNoteSlug(slug, kind) };
  } catch (error: unknown) {
    return { ok: false, result: invalidRequestResult(error) };
  }
}

function validateOwner(
  owner: string | undefined,
): { ok: true; owner: string | undefined } | { ok: false; result: ToolDomainResult } {
  if (owner === undefined) {
    return { ok: true, owner: undefined };
  }

  try {
    return { ok: true, owner: assertOwnerId(owner) };
  } catch (error: unknown) {
    return { ok: false, result: invalidRequestResult(error) };
  }
}

function resolveSourcePath(slug: string, kbSubsystem?: KbSubsystem): string {
  return kbSubsystem?.kb.sourcePath(slug) ?? sourcePathFromName(slug);
}

function resolveNotePath(slug: string, kbSubsystem?: KbSubsystem): string {
  return kbSubsystem?.kb.notePath(slug) ?? notePathFromName(slug);
}

function resolveCommunityPath(slug: string, kbSubsystem?: KbSubsystem): string {
  return kbSubsystem?.kb.communityPath(slug) ?? communityPathFromName(slug);
}

function resolvePrinciplePath(slug: string, kbSubsystem?: KbSubsystem): string {
  return kbSubsystem?.kb.principlePath(slug) ?? principlePathFromName(slug);
}

function dispatchKbReadCandidate(
  candidate: KbResolvedReadSelector,
  ctx: CallerContext,
  runtime: KbToolRuntime,
  kbSubsystem?: KbSubsystem,
): ToolDomainResult {
  switch (candidate.kind) {
    case 'memo':
      return handleKbMemoRead(candidate.slug, ctx, runtime);
    case 'note':
      return handleKbNoteRead(candidate.slug, ctx, runtime, kbSubsystem);
    case 'community':
      return handleKbCommunityRead(candidate.slug, kbSubsystem, runtime);
    case 'source':
      return handleKbSourceRead(candidate.slug, kbSubsystem, runtime);
    case 'principle':
      return handleKbPrincipleRead(candidate.slug, kbSubsystem, runtime);
  }
}

export async function handleKbSearch(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbSearchSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(() =>
    searchKb(kbSubsystem.kb, parsed.data.query, parsed.data.top_k ?? 20, parsed.data.scope ?? 'all'),
  );
}

export function handleKbNoteRead(
  slug: string,
  _ctx: CallerContext,
  runtime: KbToolRuntime,
  kbSubsystem?: KbSubsystem,
): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'note');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const notePath = resolveNotePath(normalized.slug, kbSubsystem);
    if (!runtime.storage.existsSync(notePath)) {
      return kbNotFoundResult('note', normalized.slug);
    }

    const raw = runtime.storage.readFileSync(notePath, 'utf-8');
    const frontmatter = parseFrontmatter(raw);
    const title = extractTitle(raw);
    const body = extractBody(raw);
    return domainSuccess({
      kind: 'note',
      note: normalized.slug,
      title,
      content: body,
      tags: frontmatter.tags,
      principles: frontmatter.principles,
      updatedAt: frontmatter.updatedAt,
    });
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

export function handleKbSourceRead(
  slug: string,
  kbSubsystem: KbSubsystem | undefined,
  runtime: KbToolRuntime,
): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'source');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const sourcePath = resolveSourcePath(normalized.slug, kbSubsystem);
    if (!runtime.storage.existsSync(sourcePath)) {
      return kbNotFoundResult('source', normalized.slug);
    }

    const raw = runtime.storage.readFileSync(sourcePath, 'utf-8');
    const frontmatter = parseSourceFrontmatter(raw);
    const title = frontmatter.title;
    const body = extractBody(raw);
    return domainSuccess({
      kind: 'source',
      note: normalized.slug,
      title,
      content: body,
      tags: frontmatter.tags,
      principles: [],
    });
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

export function handleKbCommunityRead(
  slug: string,
  kbSubsystem: KbSubsystem | undefined,
  runtime: KbToolRuntime,
): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'community');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const communityPath = resolveCommunityPath(normalized.slug, kbSubsystem);
    if (!runtime.storage.existsSync(communityPath)) {
      return kbNotFoundResult('community', normalized.slug);
    }

    const raw = runtime.storage.readFileSync(communityPath, 'utf-8');
    const frontmatter = parseCommunityFrontmatter(raw);
    const title = extractTitle(raw);
    const body = extractBody(raw);
    const { level, parent, children, updatedAt } = frontmatter;
    const summary = parseSummaryFromBody(body);
    return domainSuccess({
      kind: 'community',
      note: normalized.slug,
      title,
      content: body,
      tags: [],
      principles: [],
      members: parseMembersFromBody(body),
      level,
      ...(parent === undefined ? {} : { parent }),
      ...(children === undefined ? {} : { children }),
      ...(summary === undefined ? {} : { summary }),
      updatedAt,
    });
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

export function handleKbMemoRead(slug: string, ctx: CallerContext, runtime: KbToolRuntime): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'memo');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const memoPath = join(memoDir(ctx.projectRoot), `${normalized.slug}.md`);
    if (!runtime.storage.existsSync(memoPath)) {
      return kbNotFoundResult('memo', normalized.slug);
    }

    const raw = runtime.storage.readFileSync(memoPath, 'utf-8');
    return domainSuccess({
      kind: 'memo',
      note: normalized.slug,
      title: normalized.slug,
      content: extractBody(raw),
      tags: [],
      principles: [],
    });
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

export function handleKbPrincipleRead(
  slug: string,
  kbSubsystem: KbSubsystem | undefined,
  runtime: KbToolRuntime,
): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'principle');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const principlePath = resolvePrinciplePath(normalized.slug, kbSubsystem);
    if (!runtime.storage.existsSync(principlePath)) {
      return kbNotFoundResult('principle', normalized.slug);
    }

    const raw = runtime.storage.readFileSync(principlePath, 'utf-8');
    const updatedAtMatch = raw.match(/^updatedAt:\s*(.+)$/m);
    return domainSuccess({
      kind: 'principle',
      note: normalized.slug,
      title: normalized.slug,
      content: extractPrincipleStatement(raw),
      rawContent: raw,
      tags: [],
      principles: [],
      updatedAt: updatedAtMatch?.[1]?.trim(),
    });
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

export function handleKbRead(
  args: KbArgs,
  ctx: CallerContext,
  runtime: KbToolRuntime,
  kbSubsystem?: KbSubsystem,
): ToolDomainResult {
  const parsed = kbReadSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  try {
    const selector = parseKbSelector(parsed.data.note);

    for (const candidate of expandKbReadSelector(selector)) {
      const result = dispatchKbReadCandidate(candidate, ctx, runtime, kbSubsystem);
      if (!result.ok && result.code === 'not_found') {
        continue;
      }

      return result;
    }

    return domainError('not_found', `KB entry not found: ${parsed.data.note}`);
  } catch (error: unknown) {
    return invalidRequestResult(error);
  }
}

export async function handleKbPromote(
  args: KbArgs,
  kbSubsystem: KbSubsystem,
  ctx: CallerContext,
): Promise<ToolDomainResult> {
  const parsed = kbPromoteSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await kbPromote(kbSubsystem.kb, ctx.projectRoot, parsed.data, () => {
      kbSubsystem.curateScheduler.schedule();
    });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbUpdate(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbUpdateSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await kbUpdate(kbSubsystem.kb, {
      note: parsed.data.note,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.content !== undefined ? { content: parsed.data.content } : {}),
    });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbDelete(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await kbDeleteFn(kbSubsystem.kb, { note: parsed.data.note });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbSourceImport(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbSourceImportSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await persistPreparedSource(kbSubsystem.kb, parsed.data.stagedPath, parsed.data.slug);
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbSourceList(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbSourceListSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(() => listSources(kbSubsystem.kb));
}

export async function handleKbSourceDelete(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbSourceDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await deleteSource(kbSubsystem.kb, { slug: parsed.data.slug });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbReindex(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbReindexSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(() => kbReindex(kbSubsystem.kb));
}

export async function handleKbPrinciples(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const parsed = kbPrinciplesSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const index = await kbSubsystem.kb.ensureIndex();
    const allNames = Object.keys(index.principles).sort(compareLocale);
    const total = allNames.length;
    let names = allNames;

    if (parsed.data.query?.trim()) {
      const loweredQuery = parsed.data.query.toLowerCase();
      names = allNames.filter((name) => name.toLowerCase().includes(loweredQuery));
    }

    names = names.slice(0, parsed.data.top_k ?? 100);
    if (parsed.data.verbose !== true) {
      return { principles: names, total };
    }

    const selected = new Set(names);
    const notesByPrinciple = new Map(names.map((name) => [name, [] as string[]]));
    const orphanRefs = new Set<string>();
    const noteEntries = Object.values(index.entries)
      .filter(isNoteEntry)
      .sort((left, right) => compareLocale(left.slug, right.slug));

    for (const noteRecord of noteEntries) {
      for (const principle of noteRecord.principles) {
        if (selected.has(principle)) {
          notesByPrinciple.get(principle)?.push(noteRecord.slug);
          continue;
        }

        if (!(principle in index.principles)) {
          orphanRefs.add(principle);
        }
      }
    }

    const warning =
      orphanRefs.size === 0 ? undefined : `Orphan principle refs: ${[...orphanRefs].sort(compareLocale).join(', ')}`;

    return {
      principles: names.map((name) => ({
        name,
        statement: index.principles[name],
        notes: notesByPrinciple.get(name) ?? [],
      })),
      total,
      ...(warning === undefined ? {} : { warning }),
    };
  });
}

export function handleKbMemo(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const parsed = kbMemoSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  const owner = validateOwner(parsed.data.owner);
  if (!owner.ok) {
    return owner.result;
  }

  return runKbSyncAction(() =>
    writeMemo(ctx.projectRoot, {
      topic: parsed.data.topic,
      content: parsed.data.content,
      owner: parsed.data.owner,
    }),
  );
}

export function handleKbMemoList(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const parsed = kbMemoListSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  const owner = validateOwner(parsed.data.owner);
  if (!owner.ok) {
    return owner.result;
  }

  return runKbSyncAction(() => listMemos(ctx.projectRoot, owner.owner));
}

export function handleKbMemoDelete(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const parsed = kbMemoDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return handleKbMemoDeleteConsolidated(parsed.data, ctx);
}

export function handleKbMemoPurge(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const parsed = kbMemoPurgeSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return handleKbMemoDeleteConsolidated({ owner: parsed.data.owner, all: true }, ctx);
}

export function handleKbMemoDeleteConsolidated(
  args: { pattern?: string; owner?: string; all?: boolean },
  ctx: CallerContext,
): ToolDomainResult {
  const parsed = kbMemoDeleteConsolidatedSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  const owner = validateOwner(parsed.data.owner);
  if (!owner.ok) {
    return owner.result;
  }

  const hasPattern = parsed.data.pattern !== undefined;
  const purgeAll = parsed.data.all === true;
  if (hasPattern === purgeAll) {
    return domainError('invalid_request', 'Exactly one of pattern or all=true must be provided');
  }

  const { pattern } = parsed.data;
  if (pattern !== undefined) {
    return runKbSyncAction(() => deleteMemos(ctx.projectRoot, { pattern, owner: owner.owner }));
  }

  return runKbSyncAction(() => purgeMemos(ctx.projectRoot, owner.owner));
}
