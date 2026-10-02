import { deleteNote } from './ops/delete.js';
import { deleteMemos, purgeMemos, writeMemo } from './ops/memo.js';
import { promote as kbPromote } from './ops/promote.js';
import { deleteSource } from './ops/source/store.js';
import { update as kbUpdate } from './ops/update.js';
import { adoptIntoWiki } from './ops/wiki/adopt.js';
import { citeWikiKnowledge } from './ops/wiki/cite.js';
import { createWiki } from './ops/wiki/create.js';
import { deleteWiki } from './ops/wiki/delete.js';
import { linkWikiKnowledge } from './ops/wiki/link.js';
import { rewriteWikiUnderstanding } from './ops/wiki/rewrite.js';
import { unlinkWikiKnowledge } from './ops/wiki/unlink.js';
import { applyCommunitySummary } from './curate/community/summary-surface.js';
import { deriveKbErrorMessage, kbError, kbSuccess, kbValidationError, type KbToolResult } from './result.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { assertOwnerId } from '../infra/identifiers.js';
import type { KbToolRuntime, KnowledgeBaseRuntime } from './runtime-contract.js';
import {
  kbCommunitySetSummarySchema,
  kbDeleteSchema,
  kbMemoDeleteConsolidatedSchema,
  kbMemoSchema,
  kbPromoteSchema,
  kbSourceDeleteSchema,
  kbUpdateSchema,
  kbWikiAdoptSchema,
  kbWikiCiteSchema,
  kbWikiCreateSchema,
  kbWikiDeleteSchema,
  kbWikiLinkSchema,
  kbWikiRewriteSchema,
  kbWikiUnlinkSchema,
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
