import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CurateHandle } from '../kb/curate.js';
import { parseMembersFromBody, parseSummaryFromBody } from '../kb/community-detection.js';
import type { KbRuntime } from '../kb/contracts.js';
import { ZodError, z } from 'zod';
import { deleteFn as kbDeleteFn } from '../kb/delete.js';
import { extractBody, extractPrincipleStatement } from '../kb/frontmatter.js';
import { deleteMemos, listMemos, purgeMemos, writeMemo } from '../kb/memo.js';
import {
  memoDir,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
  communityPathFromName,
} from '../kb/paths.js';
import { promote as kbPromote } from '../kb/promote.js';
import { loadKbCommunity, loadKbNote, loadKbSource } from '../kb/read.js';
import { reindex as kbReindex } from '../kb/reindex.js';
import { searchKb } from '../kb/search.js';
import { deleteSource, listSources, persistPreparedSource } from '../kb/source-store.js';
import { isNoteEntry } from '../kb/types.js';
import { update as kbUpdate } from '../kb/update.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, compareLocale } from '../kb/validation.js';
import {
  expandKbReadSelector,
  parseKbSelector,
  type KbReadKind,
  type KbResolvedReadSelector,
} from '../shared/kb-read-contract.js';
import { assertOwnerId } from '../shared/utils.js';
import type { CallerContext } from './request-context.js';
import { deriveLegacyErrorMessage, domainError, domainSuccess, type ToolDomainResult } from './tool-response.js';

export type KbSubsystem = {
  kb: KbRuntime;
  curateScheduler: CurateHandle;
};

type KbArgs = Record<string, unknown>;

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
  return domainError('kb_error', deriveLegacyErrorMessage('kb_error', detail), detail);
}

function toolValidationError(error: ZodError): ToolDomainResult {
  return domainError('invalid_request', error.message);
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
  return domainError('invalid_request', deriveLegacyErrorMessage('invalid_request', error));
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

function resolveCommunityPath(slug: string, kbSubsystem?: KbSubsystem): string {
  return kbSubsystem?.kb.communityPath(slug) ?? communityPathFromName(slug);
}

function resolvePrinciplePath(slug: string, kbSubsystem?: KbSubsystem): string {
  return kbSubsystem?.kb.principlePath(slug) ?? principlePathFromName(slug);
}

function dispatchKbReadCandidate(
  candidate: KbResolvedReadSelector,
  ctx: CallerContext,
  kbSubsystem?: KbSubsystem,
): ToolDomainResult {
  switch (candidate.kind) {
    case 'memo':
      return handleKbMemoRead(candidate.slug, ctx);
    case 'note':
      return handleKbNoteRead(candidate.slug, ctx);
    case 'community':
      return handleKbCommunityRead(candidate.slug, kbSubsystem);
    case 'source':
      return handleKbSourceRead(candidate.slug, kbSubsystem);
    case 'principle':
      return handleKbPrincipleRead(candidate.slug, kbSubsystem);
  }
}

export async function handleKbSearch(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    const parsed = kbSearchSchema.parse(args);
    return runKbAction(() => searchKb(kbSubsystem.kb, parsed.query, parsed.top_k ?? 20, parsed.scope ?? 'all'));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export function handleKbNoteRead(slug: string, _ctx: CallerContext): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'note');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const notePath = notePathFromName(normalized.slug);
    if (!existsSync(notePath)) {
      return kbNotFoundResult('note', normalized.slug);
    }

    const { frontmatter, title, body } = loadKbNote(notePath);
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

export function handleKbSourceRead(slug: string, kbSubsystem?: KbSubsystem): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'source');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const sourcePath = resolveSourcePath(normalized.slug, kbSubsystem);
    if (!existsSync(sourcePath)) {
      return kbNotFoundResult('source', normalized.slug);
    }

    const { frontmatter, title, body } = loadKbSource(sourcePath);
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

export function handleKbCommunityRead(slug: string, kbSubsystem?: KbSubsystem): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'community');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const communityPath = resolveCommunityPath(normalized.slug, kbSubsystem);
    if (!existsSync(communityPath)) {
      return kbNotFoundResult('community', normalized.slug);
    }

    const { title, body, level, parent, children, updatedAt } = loadKbCommunity(communityPath);
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

export function handleKbMemoRead(slug: string, ctx: CallerContext): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'memo');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const memoPath = join(memoDir(ctx.projectRoot), `${normalized.slug}.md`);
    if (!existsSync(memoPath)) {
      return kbNotFoundResult('memo', normalized.slug);
    }

    const raw = readFileSync(memoPath, 'utf-8');
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

export function handleKbPrincipleRead(slug: string, kbSubsystem?: KbSubsystem): ToolDomainResult {
  const normalized = normalizeKbSlug(slug, 'principle');
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const principlePath = resolvePrinciplePath(normalized.slug, kbSubsystem);
    if (!existsSync(principlePath)) {
      return kbNotFoundResult('principle', normalized.slug);
    }

    const raw = readFileSync(principlePath, 'utf-8');
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

export function handleKbRead(args: KbArgs, ctx: CallerContext, kbSubsystem?: KbSubsystem): ToolDomainResult {
  try {
    const parsed = kbReadSchema.parse(args);
    const selector = parseKbSelector(parsed.note);

    for (const candidate of expandKbReadSelector(selector)) {
      const result = dispatchKbReadCandidate(candidate, ctx, kbSubsystem);
      if (result.ok) {
        return result;
      }
      if (result.code !== 'not_found') {
        return result;
      }
    }

    return domainError('not_found', `KB entry not found: ${parsed.note}`);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    return invalidRequestResult(error);
  }
}

export async function handleKbPromote(
  args: KbArgs,
  kbSubsystem: KbSubsystem,
  ctx: CallerContext,
): Promise<ToolDomainResult> {
  try {
    const parsed = kbPromoteSchema.parse(args);
    return runKbAction(async () => {
      const result = await kbPromote(kbSubsystem.kb, ctx.projectRoot, parsed, () => {
        kbSubsystem.curateScheduler.schedule();
      });
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      return result;
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export async function handleKbUpdate(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    const parsed = kbUpdateSchema.parse(args);
    return runKbAction(async () => {
      const result = await kbUpdate(kbSubsystem.kb, {
        note: parsed.note,
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.content !== undefined ? { content: parsed.content } : {}),
      });
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      return result;
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export async function handleKbDelete(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    const parsed = kbDeleteSchema.parse(args);
    return runKbAction(async () => {
      const result = await kbDeleteFn(kbSubsystem.kb, { note: parsed.note });
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      return result;
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export async function handleKbSourceImport(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    const parsed = kbSourceImportSchema.parse(args);
    return runKbAction(async () => {
      const result = await persistPreparedSource(kbSubsystem.kb, parsed.stagedPath, parsed.slug);
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      return result;
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export async function handleKbSourceList(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    kbSourceListSchema.parse(args);
    return runKbAction(() => listSources(kbSubsystem.kb));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export async function handleKbSourceDelete(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    const parsed = kbSourceDeleteSchema.parse(args);
    return runKbAction(async () => {
      const result = await deleteSource(kbSubsystem.kb, { slug: parsed.slug });
      kbSubsystem.curateScheduler.scheduleDeferredCommit();
      return result;
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export async function handleKbReindex(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    kbReindexSchema.parse(args);
    return runKbAction(() => kbReindex(kbSubsystem.kb));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export async function handleKbPrinciples(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  try {
    const parsed = kbPrinciplesSchema.parse(args);
    return runKbAction(async () => {
      const index = await kbSubsystem.kb.ensureIndex();
      const allNames = Object.keys(index.principles).sort(compareLocale);
      const total = allNames.length;
      let names = allNames;

      if (parsed.query?.trim()) {
        const loweredQuery = parsed.query.toLowerCase();
        names = allNames.filter((name) => name.toLowerCase().includes(loweredQuery));
      }

      names = names.slice(0, parsed.top_k ?? 100);
      if (parsed.verbose !== true) {
        return { principles: names, total };
      }

      const selected = new Set(names);
      const notesByPrinciple = new Map(names.map((name) => [name, [] as string[]]));
      const orphanRefs = new Set<string>();

      for (const noteRecord of Object.values(index.entries)
        .filter(isNoteEntry)
        .sort((left, right) => compareLocale(left.slug, right.slug))) {
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

      return {
        principles: names.map((name) => ({
          name,
          statement: index.principles[name],
          notes: notesByPrinciple.get(name) ?? [],
        })),
        total,
        ...(orphanRefs.size === 0
          ? {}
          : { warning: `Orphan principle refs: ${[...orphanRefs].sort(compareLocale).join(', ')}` }),
      };
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export function handleKbMemo(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  try {
    const parsed = kbMemoSchema.parse(args);
    const owner = validateOwner(parsed.owner);
    if (!owner.ok) {
      return owner.result;
    }

    return runKbSyncAction(() =>
      writeMemo(ctx.projectRoot, { topic: parsed.topic, content: parsed.content, owner: parsed.owner }),
    );
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export function handleKbMemoList(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  try {
    const parsed = kbMemoListSchema.parse(args);
    const owner = validateOwner(parsed.owner);
    if (!owner.ok) {
      return owner.result;
    }

    return runKbSyncAction(() => listMemos(ctx.projectRoot, owner.owner));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export function handleKbMemoDelete(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  try {
    const parsed = kbMemoDeleteSchema.parse(args);
    return handleKbMemoDeleteConsolidated(parsed, ctx);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export function handleKbMemoPurge(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  try {
    const parsed = kbMemoPurgeSchema.parse(args);
    return handleKbMemoDeleteConsolidated({ owner: parsed.owner, all: true }, ctx);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}

export function handleKbMemoDeleteConsolidated(
  args: { pattern?: string; owner?: string; all?: boolean },
  ctx: CallerContext,
): ToolDomainResult {
  try {
    const parsed = kbMemoDeleteConsolidatedSchema.parse(args);
    const owner = validateOwner(parsed.owner);
    if (!owner.ok) {
      return owner.result;
    }

    const hasPattern = parsed.pattern !== undefined;
    const purgeAll = parsed.all === true;
    if (hasPattern === purgeAll) {
      return domainError('invalid_request', 'Exactly one of pattern or all=true must be provided');
    }

    if (hasPattern) {
      return runKbSyncAction(() => deleteMemos(ctx.projectRoot, { pattern: parsed.pattern!, owner: owner.owner }));
    }

    return runKbSyncAction(() => purgeMemos(ctx.projectRoot, owner.owner));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}
