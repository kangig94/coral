import { deleteNote } from './ops/delete.js';
import { deleteMemos, listMemos, purgeMemos, writeMemo } from './ops/memo.js';
import { promote as kbPromote } from './ops/promote.js';
import { listPrinciples } from './ops/principles-list.js';
import { searchKb } from './ops/search.js';
import { deleteSource, listSources } from './ops/source/store.js';
import { update as kbUpdate } from './ops/update.js';
import { adoptIntoWiki } from './ops/wiki/adopt.js';
import { citeWikiKnowledge } from './ops/wiki/cite.js';
import { createWiki } from './ops/wiki/create.js';
import { deleteWiki } from './ops/wiki/delete.js';
import { linkWikiKnowledge } from './ops/wiki/link.js';
import { listWikis } from './ops/wiki/list.js';
import { rewriteWikiUnderstanding } from './ops/wiki/rewrite.js';
import { unlinkWikiKnowledge } from './ops/wiki/unlink.js';
import { generateWakeUpPacket } from './ops/wake-up.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { readCurateConflictQuarantine } from './curate/conflict-quarantine.js';
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, assertWikiSlug } from './validation.js';
import { applyCommunitySummary } from './curate/community/summary-surface.js';
import { type KbReadKind } from './selector.js';
import { readEntry, readEntryByKind, type KbReadOptions, type KbReadPathResolver } from './read.js';
import { deriveKbErrorMessage, kbError, kbSuccess, kbValidationError, type KbToolResult } from './result.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { assertOwnerId } from '../infra/identifiers.js';
import type { KbToolRuntime, KnowledgeBaseRuntime } from './runtime-contract.js';
import { buildKbDiagnoseResult } from './diagnose.js';
import {
  kbCommunitySetSummarySchema,
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
  kbWakeUpSchema,
  kbWikiAdoptSchema,
  kbWikiCiteSchema,
  kbWikiCreateSchema,
  kbWikiDeleteSchema,
  kbWikiLinkSchema,
  kbWikiListSchema,
  kbWikiReadSchema,
  kbWikiRewriteSchema,
  kbWikiUnlinkSchema,
} from './tool-contracts.js';

type KbArgs = Record<string, unknown>;

function asAbortSignal(value: unknown): AbortSignal | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    'addEventListener' in value &&
    'removeEventListener' in value
    ? (value as AbortSignal)
    : undefined;
}

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

function runKbMutationAction(kbRuntime: KnowledgeBaseRuntime, action: () => Promise<unknown>): Promise<KbToolResult> {
  return runKbAction(async () => {
    const result = await action();
    kbRuntime.curateScheduler.scheduleDeferredCommit();
    return result;
  });
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

    if (kind === 'wiki') {
      return { ok: true, slug: assertWikiSlug(slug, kind) };
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

function requireKbRuntime(kbRuntime: KnowledgeBaseRuntime | undefined): KnowledgeBaseRuntime {
  if (kbRuntime === undefined) {
    throw new Error('KB runtime is required.');
  }
  return kbRuntime;
}

function kbReadPaths(kbRuntime: KnowledgeBaseRuntime | undefined): KbReadPathResolver {
  const required = requireKbRuntime(kbRuntime);
  return {
    notePath: (slug) => required.kb.notePath(slug),
    wikiPath: (slug) => required.kb.wikiPath(slug),
    sourcePath: (slug) => required.kb.sourcePath(slug),
    communityPath: (slug) => required.kb.communityPath(slug),
    principlePath: (slug) => required.kb.principlePath(slug),
  };
}

function buildKbReadOptions(
  kind: KbReadKind,
  ctx: InvocationContext | undefined,
  runtime: KbToolRuntime,
  kbRuntime: KnowledgeBaseRuntime | undefined,
): KbReadOptions {
  const options: KbReadOptions = {
    ...(ctx?.projectRoot === undefined ? {} : { projectDataDir: runtime.paths.projectData(ctx.projectRoot) }),
    storage: runtime.storage,
  };
  return kind === 'memo'
    ? options
    : {
        ...options,
        paths: kbReadPaths(kbRuntime),
        ...(kbRuntime === undefined
          ? {}
          : {
              communityDocumentProvider: {
                readGeneratedCommunityDocument: (slug: string) =>
                  kbRuntime.kb.generatedCommunityProjectionStore.readCommunityDocument(slug),
              },
            }),
      };
}

function handleKbTypedRead(
  kind: KbReadKind,
  slug: string,
  ctx: InvocationContext | undefined,
  runtime: KbToolRuntime,
  kbRuntime?: KnowledgeBaseRuntime,
): KbToolResult {
  const normalized = normalizeKbSlug(slug, kind);
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const entry = readEntryByKind(kind, normalized.slug, buildKbReadOptions(kind, ctx, runtime, kbRuntime));
    return entry === null ? kbNotFoundResult(kind, normalized.slug) : kbSuccess(entry);
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

export async function handleKbSearch(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbSearchSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(() =>
    searchKb(
      kbRuntime.kb,
      parsed.data.query,
      parsed.data.top_k ?? 20,
      parsed.data.scope ?? 'all',
      parsed.data.mode ?? 'auto',
      asAbortSignal(args.abortSignal),
    ),
  );
}

export function handleKbNoteRead(
  slug: string,
  ctx: InvocationContext,
  runtime: KbToolRuntime,
  kbRuntime?: KnowledgeBaseRuntime,
): KbToolResult {
  return handleKbTypedRead('note', slug, ctx, runtime, kbRuntime);
}

export function handleKbSourceRead(
  slug: string,
  kbRuntime: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  return handleKbTypedRead('source', slug, undefined, runtime, kbRuntime);
}

export function handleKbCommunityRead(
  slug: string,
  kbRuntime: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  return handleKbTypedRead('community', slug, undefined, runtime, kbRuntime);
}

export function handleKbWikiRead(
  slugOrArgs: string | KbArgs,
  kbRuntime: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  const parsed = kbWikiReadSchema.safeParse(typeof slugOrArgs === 'string' ? { slug: slugOrArgs } : slugOrArgs);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return handleKbTypedRead('wiki', parsed.data.slug, undefined, runtime, kbRuntime);
}

export function handleKbMemoRead(slug: string, ctx: InvocationContext, runtime: KbToolRuntime): KbToolResult {
  return handleKbTypedRead('memo', slug, ctx, runtime);
}

export function handleKbPrincipleRead(
  slug: string,
  kbRuntime: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  return handleKbTypedRead('principle', slug, undefined, runtime, kbRuntime);
}

export function handleKbRead(
  args: KbArgs,
  ctx: InvocationContext,
  runtime: KbToolRuntime,
  kbRuntime?: KnowledgeBaseRuntime,
): KbToolResult {
  const parsed = kbReadSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  try {
    return kbSuccess(
      readEntry(parsed.data, {
        ...(ctx.projectRoot === undefined ? {} : { projectDataDir: runtime.paths.projectData(ctx.projectRoot) }),
        storage: runtime.storage,
        paths: kbReadPaths(kbRuntime),
        ...(kbRuntime === undefined
          ? {}
          : {
              communityDocumentProvider: {
                readGeneratedCommunityDocument: (slug: string) =>
                  kbRuntime.kb.generatedCommunityProjectionStore.readCommunityDocument(slug),
              },
            }),
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
  kbRuntime: KnowledgeBaseRuntime,
  ctx: InvocationContext,
  runtime: KbToolRuntime,
): Promise<KbToolResult> {
  const parsed = kbPromoteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () =>
    kbPromote(kbRuntime.kb, runtime.paths.projectData(ctx.projectRoot), parsed.data, () => {
      kbRuntime.curateScheduler.schedule();
    }),
  );
}

export async function handleKbUpdate(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbUpdateSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () =>
    kbUpdate(kbRuntime.kb, {
      note: parsed.data.note,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.content !== undefined ? { content: parsed.data.content } : {}),
    }),
  );
}

export async function handleKbDelete(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => deleteNote(kbRuntime.kb, { note: parsed.data.note }));
}

export async function handleKbWikiCreate(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiCreateSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => createWiki(kbRuntime.kb, parsed.data));
}

export async function handleKbWikiRewrite(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiRewriteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => rewriteWikiUnderstanding(kbRuntime.kb, parsed.data));
}

export async function handleKbWikiLink(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiLinkSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => linkWikiKnowledge(kbRuntime.kb, parsed.data));
}

export async function handleKbWikiUnlink(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiUnlinkSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => unlinkWikiKnowledge(kbRuntime.kb, parsed.data));
}

export async function handleKbWikiCite(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiCiteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => citeWikiKnowledge(kbRuntime.kb, parsed.data));
}

export async function handleKbWikiAdopt(
  args: KbArgs,
  kbRuntime: KnowledgeBaseRuntime,
  ctx: InvocationContext,
  runtime: KbToolRuntime,
): Promise<KbToolResult> {
  const parsed = kbWikiAdoptSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () =>
    adoptIntoWiki(kbRuntime.kb, runtime.paths.projectData(ctx.projectRoot), parsed.data, () => {
      kbRuntime.curateScheduler.schedule();
    }),
  );
}

export async function handleKbWikiDelete(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => deleteWiki(kbRuntime.kb, parsed.data));
}

export async function handleKbWikiList(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiListSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => {
    return { wikis: await listWikis(kbRuntime.kb) };
  });
}

export async function handleKbWakeUp(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWakeUpSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => ({
    content: await generateWakeUpPacket(kbRuntime.kb, parsed.data.project),
  }));
}

export function handleKbDiagnose(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): KbToolResult {
  const parsed = kbDiagnoseSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbSyncAction(() =>
    buildKbDiagnoseResult(readCurateRetryQueue(kbRuntime.readDb), readCurateConflictQuarantine(kbRuntime.readDb)),
  );
}

export async function handleKbSourceList(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbSourceListSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(() => listSources(kbRuntime.kb));
}

export async function handleKbSourceDelete(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbSourceDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, () => deleteSource(kbRuntime.kb, { slug: parsed.data.slug }));
}

export async function handleKbCommunitySetSummary(
  args: KbArgs,
  kbRuntime: KnowledgeBaseRuntime,
): Promise<KbToolResult> {
  const parsed = kbCommunitySetSummarySchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbRuntime, async () => {
    const { written } = await applyCommunitySummary(kbRuntime.kb, parsed.data.slug, parsed.data.summary);
    if (!written) {
      throw new Error(`KB community not found: ${parsed.data.slug}`);
    }
    return { slug: parsed.data.slug };
  });
}

export async function handleKbPrinciples(args: KbArgs, kbRuntime: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbPrinciplesSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => {
    return listPrinciples(kbRuntime.kb, parsed.data);
  });
}

export function handleKbMemo(args: KbArgs, ctx: InvocationContext, runtime: KbToolRuntime): KbToolResult {
  const parsed = kbMemoSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  const owner = validateOwner(parsed.data.owner);
  if (!owner.ok) {
    return owner.result;
  }

  return runKbSyncAction(() =>
    writeMemo(
      { storagePort: runtime.storage, ids: runtime.ids },
      runtime.paths.projectData(ctx.projectRoot),
      runtime.paths.projectSource(ctx.projectRoot),
      {
        topic: parsed.data.topic,
        content: parsed.data.content,
        owner: parsed.data.owner,
      },
      runtime.time,
    ),
  );
}

export function handleKbMemoList(args: KbArgs, ctx: InvocationContext, runtime: KbToolRuntime): KbToolResult {
  const parsed = kbMemoListSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  const owner = validateOwner(parsed.data.owner);
  if (!owner.ok) {
    return owner.result;
  }

  return runKbSyncAction(() => listMemos(runtime.storage, runtime.paths.projectData(ctx.projectRoot), owner.owner));
}

export function handleKbMemoDelete(args: KbArgs, ctx: InvocationContext, runtime: KbToolRuntime): KbToolResult {
  const parsed = kbMemoDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return handleKbMemoDeleteConsolidated(parsed.data, ctx, runtime);
}

export function handleKbMemoPurge(args: KbArgs, ctx: InvocationContext, runtime: KbToolRuntime): KbToolResult {
  const parsed = kbMemoPurgeSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return handleKbMemoDeleteConsolidated({ owner: parsed.data.owner, all: true }, ctx, runtime);
}

export function handleKbMemoDeleteConsolidated(
  args: { pattern?: string; owner?: string; all?: boolean },
  ctx: InvocationContext,
  runtime: KbToolRuntime,
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
  const projectDataDir = runtime.paths.projectData(ctx.projectRoot);
  if (pattern !== undefined) {
    return runKbSyncAction(() => deleteMemos(runtime.storage, projectDataDir, { pattern, owner: owner.owner }));
  }

  return runKbSyncAction(() => purgeMemos(runtime.storage, projectDataDir, owner.owner));
}
