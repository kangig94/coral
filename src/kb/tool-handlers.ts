import { join } from 'node:path';

import { deleteFn as kbDeleteFn } from './ops/delete.js';
import {
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseCommunityFrontmatter,
  parseFrontmatter,
  parseMembersFromBody,
  parseSourceFrontmatter,
  parseSummaryFromBody,
} from './corpus/frontmatter.js';
import { deleteMemos, listMemos, purgeMemos, writeMemo } from './ops/memo.js';
import {
  memoDir,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
  communityPathFromName,
} from './paths.js';
import { promote as kbPromote } from './ops/promote.js';
import { reindex as kbReindex } from './ops/reindex.js';
import { searchKb } from './ops/search.js';
import { deleteSource, listSources, persistPreparedSource } from './ops/source-store.js';
import { isNoteEntry } from './entry-types.js';
import { update as kbUpdate } from './ops/update.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, compareLocale } from './validation.js';
import { type KbReadKind } from './read-contract.js';
import { readEntry, type KbReadPathResolver } from './read.js';
import type { CallerContext } from '../transport/request-context.js';
import {
  deriveErrorMessage,
  domainError,
  domainSuccess,
  toolValidationError,
  type ToolDomainResult,
} from '../transport/tool-result.js';
import { assertOwnerId } from '../infra/owner-id.js';
import type { KbToolRuntime, KnowledgeBaseRuntime } from './subsystem.js';
import { buildKbDiagnoseResult } from './diagnose.js';
import {
  kbDeleteSchema,
  kbDiagnoseSchema,
  kbMemoDeleteConsolidatedSchema,
  kbMemoDeleteSchema,
  kbMemoListSchema,
  kbMemoPurgeSchema,
  kbMemoSchema,
  kbPrinciplesSchema,
  kbPromoteSchema,
  kbReadSchema,
  kbReindexSchema,
  kbSearchSchema,
  kbSourceDeleteSchema,
  kbSourceImportSchema,
  kbSourceListSchema,
  kbUpdateSchema,
} from './tool-contracts.js';

type KbArgs = Record<string, unknown>;

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

function resolveSourcePath(slug: string, kbSubsystem?: KnowledgeBaseRuntime): string {
  return kbSubsystem?.kb.sourcePath(slug) ?? sourcePathFromName(slug);
}

function resolveNotePath(slug: string, kbSubsystem?: KnowledgeBaseRuntime): string {
  return kbSubsystem?.kb.notePath(slug) ?? notePathFromName(slug);
}

function resolveCommunityPath(slug: string, kbSubsystem?: KnowledgeBaseRuntime): string {
  return kbSubsystem?.kb.communityPath(slug) ?? communityPathFromName(slug);
}

function resolvePrinciplePath(slug: string, kbSubsystem?: KnowledgeBaseRuntime): string {
  return kbSubsystem?.kb.principlePath(slug) ?? principlePathFromName(slug);
}

function kbReadPaths(kbSubsystem?: KnowledgeBaseRuntime): Partial<KbReadPathResolver> | undefined {
  if (kbSubsystem === undefined) {
    return undefined;
  }

  return {
    notePath: (slug) => kbSubsystem.kb.notePath(slug),
    sourcePath: (slug) => kbSubsystem.kb.sourcePath(slug),
    communityPath: (slug) => kbSubsystem.kb.communityPath(slug),
    principlePath: (slug) => kbSubsystem.kb.principlePath(slug),
  };
}

export async function handleKbSearch(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
  const parsed = kbSearchSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(() =>
    searchKb(
      kbSubsystem.kb,
      parsed.data.query,
      parsed.data.top_k ?? 20,
      parsed.data.scope ?? 'all',
      parsed.data.mode,
    ),
  );
}

export function handleKbNoteRead(
  slug: string,
  _ctx: CallerContext,
  runtime: KbToolRuntime,
  kbSubsystem?: KnowledgeBaseRuntime,
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
  kbSubsystem: KnowledgeBaseRuntime | undefined,
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
  kbSubsystem: KnowledgeBaseRuntime | undefined,
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
  kbSubsystem: KnowledgeBaseRuntime | undefined,
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
  kbSubsystem?: KnowledgeBaseRuntime,
): ToolDomainResult {
  const parsed = kbReadSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  try {
    return domainSuccess(
      readEntry(parsed.data, {
        projectRoot: ctx.projectRoot,
        storage: runtime.storage,
        paths: kbReadPaths(kbSubsystem),
      }),
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.message === `KB entry not found: ${parsed.data.note}`) {
      return domainError('not_found', error.message);
    }

    return invalidRequestResult(error);
  }
}

export async function handleKbPromote(
  args: KbArgs,
  kbSubsystem: KnowledgeBaseRuntime,
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

export async function handleKbUpdate(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
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

export async function handleKbDelete(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
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

export async function handleKbSourceImport(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
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

export function handleKbDiagnose(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): ToolDomainResult {
  const parsed = kbDiagnoseSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbSyncAction(() => buildKbDiagnoseResult(readCurateRetryQueue(kbSubsystem.kb.db)));
}

export async function handleKbSourceList(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
  const parsed = kbSourceListSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(() => listSources(kbSubsystem.kb));
}

export async function handleKbSourceDelete(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
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

export async function handleKbReindex(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
  const parsed = kbReindexSchema.safeParse(args);
  if (!parsed.success) {
    return toolValidationError(parsed.error);
  }

  return runKbAction(() => kbReindex(kbSubsystem.kb));
}

export async function handleKbPrinciples(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<ToolDomainResult> {
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
