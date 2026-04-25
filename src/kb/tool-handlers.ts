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
import { memoDir } from './paths.js';
import { promote as kbPromote } from './ops/promote.js';
import { listPrinciples } from './ops/principles-list.js';
import { searchKb } from './ops/search.js';
import { deleteSource, listSources } from './ops/source-store.js';
import { update as kbUpdate } from './ops/update.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug } from './validation.js';
import { type KbReadKind } from './read-contract.js';
import { readEntry, type KbReadPathResolver } from './read.js';
import { deriveKbErrorMessage, kbError, kbSuccess, kbValidationError, type KbToolResult } from './result.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
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
  kbSearchSchema,
  kbSourceDeleteSchema,
  kbSourceListSchema,
  kbUpdateSchema,
} from './tool-contracts.js';

type KbArgs = Record<string, unknown>;

function kbErrorResult(error: unknown): KbToolResult {
  const detail = error instanceof Error ? { message: error.message } : error;
  return kbError('kb_error', deriveKbErrorMessage('kb_error', detail), detail);
}

async function runKbAction(action: () => Promise<unknown> | unknown): Promise<KbToolResult> {
  try {
    return kbSuccess(await action());
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

function runKbSyncAction(action: () => unknown): KbToolResult {
  try {
    return kbSuccess(action());
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

function invalidRequestResult(error: unknown): KbToolResult {
  return kbError('invalid_request', deriveKbErrorMessage('invalid_request', error));
}

function kbNotFoundResult(kind: KbReadKind, slug: string): KbToolResult {
  return kbError('not_found', `KB ${kind} not found: ${slug}`);
}

function normalizeKbSlug(
  slug: string,
  kind: KbReadKind,
): { ok: true; slug: string } | { ok: false; result: KbToolResult } {
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
): { ok: true; owner: string | undefined } | { ok: false; result: KbToolResult } {
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
  if (kbSubsystem === undefined) {
    throw new Error('KB subsystem is required to resolve source paths.');
  }
  return kbSubsystem.kb.sourcePath(slug);
}

function resolveNotePath(slug: string, kbSubsystem?: KnowledgeBaseRuntime): string {
  if (kbSubsystem === undefined) {
    throw new Error('KB subsystem is required to resolve note paths.');
  }
  return kbSubsystem.kb.notePath(slug);
}

function resolveCommunityPath(slug: string, kbSubsystem?: KnowledgeBaseRuntime): string {
  if (kbSubsystem === undefined) {
    throw new Error('KB subsystem is required to resolve community paths.');
  }
  return kbSubsystem.kb.communityPath(slug);
}

function resolvePrinciplePath(slug: string, kbSubsystem?: KnowledgeBaseRuntime): string {
  if (kbSubsystem === undefined) {
    throw new Error('KB subsystem is required to resolve principle paths.');
  }
  return kbSubsystem.kb.principlePath(slug);
}

function kbReadPaths(kbSubsystem?: KnowledgeBaseRuntime): KbReadPathResolver {
  if (kbSubsystem === undefined) {
    throw new Error('KB subsystem is required to resolve read paths.');
  }

  return {
    notePath: (slug) => kbSubsystem.kb.notePath(slug),
    sourcePath: (slug) => kbSubsystem.kb.sourcePath(slug),
    communityPath: (slug) => kbSubsystem.kb.communityPath(slug),
    principlePath: (slug) => kbSubsystem.kb.principlePath(slug),
  };
}

export async function handleKbSearch(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbSearchSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(() =>
    searchKb(kbSubsystem.kb, parsed.data.query, parsed.data.top_k ?? 20, parsed.data.scope ?? 'all', parsed.data.mode),
  );
}

export function handleKbNoteRead(
  slug: string,
  _ctx: InvocationContext,
  runtime: KbToolRuntime,
  kbSubsystem?: KnowledgeBaseRuntime,
): KbToolResult {
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
    return kbSuccess({
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
): KbToolResult {
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
    return kbSuccess({
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
): KbToolResult {
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
    return kbSuccess({
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

export function handleKbMemoRead(slug: string, ctx: InvocationContext, runtime: KbToolRuntime): KbToolResult {
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
    return kbSuccess({
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
): KbToolResult {
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
    return kbSuccess({
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
  ctx: InvocationContext,
  runtime: KbToolRuntime,
  kbSubsystem?: KnowledgeBaseRuntime,
): KbToolResult {
  const parsed = kbReadSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  try {
    return kbSuccess(
      readEntry(parsed.data, {
        projectRoot: ctx.projectRoot,
        storage: runtime.storage,
        paths: kbReadPaths(kbSubsystem),
      }),
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.message === `KB entry not found: ${parsed.data.note}`) {
      return kbError('not_found', error.message);
    }

    return invalidRequestResult(error);
  }
}

export async function handleKbPromote(
  args: KbArgs,
  kbSubsystem: KnowledgeBaseRuntime,
  ctx: InvocationContext,
): Promise<KbToolResult> {
  const parsed = kbPromoteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await kbPromote(kbSubsystem.kb, ctx.projectRoot, parsed.data, () => {
      kbSubsystem.curateScheduler.schedule();
    });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbUpdate(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbUpdateSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
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

export async function handleKbDelete(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await kbDeleteFn(kbSubsystem.kb, { note: parsed.data.note });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export function handleKbDiagnose(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): KbToolResult {
  const parsed = kbDiagnoseSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbSyncAction(() => buildKbDiagnoseResult(readCurateRetryQueue(kbSubsystem.kb.db)));
}

export async function handleKbSourceList(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbSourceListSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(() => listSources(kbSubsystem.kb));
}

export async function handleKbSourceDelete(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbSourceDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => {
    const result = await deleteSource(kbSubsystem.kb, { slug: parsed.data.slug });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbPrinciples(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbPrinciplesSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => {
    return listPrinciples(kbSubsystem.kb, parsed.data);
  });
}

export function handleKbMemo(args: KbArgs, ctx: InvocationContext): KbToolResult {
  const parsed = kbMemoSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
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

export function handleKbMemoList(args: KbArgs, ctx: InvocationContext): KbToolResult {
  const parsed = kbMemoListSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  const owner = validateOwner(parsed.data.owner);
  if (!owner.ok) {
    return owner.result;
  }

  return runKbSyncAction(() => listMemos(ctx.projectRoot, owner.owner));
}

export function handleKbMemoDelete(args: KbArgs, ctx: InvocationContext): KbToolResult {
  const parsed = kbMemoDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return handleKbMemoDeleteConsolidated(parsed.data, ctx);
}

export function handleKbMemoPurge(args: KbArgs, ctx: InvocationContext): KbToolResult {
  const parsed = kbMemoPurgeSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return handleKbMemoDeleteConsolidated({ owner: parsed.data.owner, all: true }, ctx);
}

export function handleKbMemoDeleteConsolidated(
  args: { pattern?: string; owner?: string; all?: boolean },
  ctx: InvocationContext,
): KbToolResult {
  const parsed = kbMemoDeleteConsolidatedSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  const owner = validateOwner(parsed.data.owner);
  if (!owner.ok) {
    return owner.result;
  }

  const hasPattern = parsed.data.pattern !== undefined;
  const purgeAll = parsed.data.all === true;
  if (hasPattern === purgeAll) {
    return kbError('invalid_request', 'Exactly one of pattern or all=true must be provided');
  }

  const { pattern } = parsed.data;
  if (pattern !== undefined) {
    return runKbSyncAction(() => deleteMemos(ctx.projectRoot, { pattern, owner: owner.owner }));
  }

  return runKbSyncAction(() => purgeMemos(ctx.projectRoot, owner.owner));
}
