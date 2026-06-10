import { deleteNote } from './ops/delete.js';
import { deleteMemos, listMemos, purgeMemos, writeMemo } from './ops/memo.js';
import { promote as kbPromote } from './ops/promote.js';
import { listPrinciples } from './ops/principles-list.js';
import { searchKb } from './ops/search.js';
import { deleteSource, listSources } from './ops/source-store.js';
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
import { assertCommunitySlug, assertNoteSlug, assertSourceSlug, assertWikiSlug } from './validation.js';
import { type KbReadKind } from './selector.js';
import { readEntry, readEntryByKind, type KbReadOptions, type KbReadPathResolver } from './read.js';
import { deriveKbErrorMessage, kbError, kbSuccess, kbValidationError, type KbToolResult } from './result.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { assertOwnerId } from '../infra/identifiers.js';
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

function runKbMutationAction(kbSubsystem: KnowledgeBaseRuntime, action: () => Promise<unknown>): Promise<KbToolResult> {
  return runKbAction(async () => {
    const result = await action();
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
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

function requireKbSubsystem(kbSubsystem: KnowledgeBaseRuntime | undefined): KnowledgeBaseRuntime {
  if (kbSubsystem === undefined) {
    throw new Error('KB subsystem is required.');
  }
  return kbSubsystem;
}

function kbReadPaths(kbSubsystem: KnowledgeBaseRuntime | undefined): KbReadPathResolver {
  const required = requireKbSubsystem(kbSubsystem);
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
  kbSubsystem: KnowledgeBaseRuntime | undefined,
): KbReadOptions {
  const options: KbReadOptions = {
    ...(ctx?.projectRoot === undefined ? {} : { projectDataDir: runtime.paths.projectData(ctx.projectRoot) }),
    storage: runtime.storage,
  };
  return kind === 'memo' ? options : { ...options, paths: kbReadPaths(kbSubsystem) };
}

function handleKbTypedRead(
  kind: KbReadKind,
  slug: string,
  ctx: InvocationContext | undefined,
  runtime: KbToolRuntime,
  kbSubsystem?: KnowledgeBaseRuntime,
): KbToolResult {
  const normalized = normalizeKbSlug(slug, kind);
  if (!normalized.ok) {
    return normalized.result;
  }

  try {
    const entry = readEntryByKind(kind, normalized.slug, buildKbReadOptions(kind, ctx, runtime, kbSubsystem));
    return entry === null ? kbNotFoundResult(kind, normalized.slug) : kbSuccess(entry);
  } catch (error: unknown) {
    return kbErrorResult(error);
  }
}

export async function handleKbSearch(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbSearchSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(() =>
    searchKb(
      kbSubsystem.kb,
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
  kbSubsystem?: KnowledgeBaseRuntime,
): KbToolResult {
  return handleKbTypedRead('note', slug, ctx, runtime, kbSubsystem);
}

export function handleKbSourceRead(
  slug: string,
  kbSubsystem: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  return handleKbTypedRead('source', slug, undefined, runtime, kbSubsystem);
}

export function handleKbCommunityRead(
  slug: string,
  kbSubsystem: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  return handleKbTypedRead('community', slug, undefined, runtime, kbSubsystem);
}

export function handleKbWikiRead(
  slugOrArgs: string | KbArgs,
  kbSubsystem: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  const parsed = kbWikiReadSchema.safeParse(typeof slugOrArgs === 'string' ? { slug: slugOrArgs } : slugOrArgs);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return handleKbTypedRead('wiki', parsed.data.slug, undefined, runtime, kbSubsystem);
}

export function handleKbMemoRead(slug: string, ctx: InvocationContext, runtime: KbToolRuntime): KbToolResult {
  return handleKbTypedRead('memo', slug, ctx, runtime);
}

export function handleKbPrincipleRead(
  slug: string,
  kbSubsystem: KnowledgeBaseRuntime | undefined,
  runtime: KbToolRuntime,
): KbToolResult {
  return handleKbTypedRead('principle', slug, undefined, runtime, kbSubsystem);
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
        ...(ctx.projectRoot === undefined ? {} : { projectDataDir: runtime.paths.projectData(ctx.projectRoot) }),
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
  runtime: KbToolRuntime,
): Promise<KbToolResult> {
  const parsed = kbPromoteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () =>
    kbPromote(kbSubsystem.kb, runtime.paths.projectData(ctx.projectRoot), parsed.data, () => {
      kbSubsystem.curateScheduler.schedule();
    }),
  );
}

export async function handleKbUpdate(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbUpdateSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () =>
    kbUpdate(kbSubsystem.kb, {
      note: parsed.data.note,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.content !== undefined ? { content: parsed.data.content } : {}),
    }),
  );
}

export async function handleKbDelete(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () => deleteNote(kbSubsystem.kb, { note: parsed.data.note }));
}

export async function handleKbWikiCreate(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiCreateSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () => createWiki(kbSubsystem.kb, parsed.data));
}

export async function handleKbWikiRewrite(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiRewriteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () => rewriteWikiUnderstanding(kbSubsystem.kb, parsed.data));
}

export async function handleKbWikiLink(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiLinkSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () => linkWikiKnowledge(kbSubsystem.kb, parsed.data));
}

export async function handleKbWikiUnlink(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiUnlinkSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () => unlinkWikiKnowledge(kbSubsystem.kb, parsed.data));
}

export async function handleKbWikiCite(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiCiteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () => citeWikiKnowledge(kbSubsystem.kb, parsed.data));
}

export async function handleKbWikiAdopt(
  args: KbArgs,
  kbSubsystem: KnowledgeBaseRuntime,
  ctx: InvocationContext,
  runtime: KbToolRuntime,
): Promise<KbToolResult> {
  const parsed = kbWikiAdoptSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () =>
    adoptIntoWiki(kbSubsystem.kb, runtime.paths.projectData(ctx.projectRoot), parsed.data, () => {
      kbSubsystem.curateScheduler.schedule();
    }),
  );
}

export async function handleKbWikiDelete(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiDeleteSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbMutationAction(kbSubsystem, () => deleteWiki(kbSubsystem.kb, parsed.data));
}

export async function handleKbWikiList(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWikiListSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => {
    return { wikis: await listWikis(kbSubsystem.kb) };
  });
}

export async function handleKbWakeUp(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): Promise<KbToolResult> {
  const parsed = kbWakeUpSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbAction(async () => ({
    content: await generateWakeUpPacket(kbSubsystem.kb, parsed.data.project),
  }));
}

export function handleKbDiagnose(args: KbArgs, kbSubsystem: KnowledgeBaseRuntime): KbToolResult {
  const parsed = kbDiagnoseSchema.safeParse(args);
  if (!parsed.success) {
    return kbValidationError(parsed.error);
  }

  return runKbSyncAction(() => buildKbDiagnoseResult(readCurateRetryQueue(kbSubsystem.readDb)));
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

  return runKbMutationAction(kbSubsystem, () => deleteSource(kbSubsystem.kb, { slug: parsed.data.slug }));
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
