import type { CurateHandle } from '../kb/curate.js';
import type { KbRuntime } from '../kb/contracts.js';
import { deleteFn as kbDeleteFn } from '../kb/delete.js';
import { deleteMemos, listMemos, purgeMemos, writeMemo } from '../kb/memo.js';
import { promote as kbPromote } from '../kb/promote.js';
import { readEntry } from '../kb/read.js';
import { reindex as kbReindex } from '../kb/reindex.js';
import { searchKb } from '../kb/search.js';
import { deleteSource, listSources, persistPreparedSource } from '../kb/source-store.js';
import { isNoteEntry, type KbSearchScope } from '../kb/types.js';
import { update as kbUpdate } from '../kb/update.js';
import { compareLocale } from '../kb/validation.js';
import { assertOwnerId } from '../shared/utils.js';
import type { CallerContext } from './request-context.js';
import {
  deriveLegacyErrorMessage,
  domainError,
  domainSuccess,
  optionalString,
  requireString,
  type ToolDomainResult,
} from './tool-response.js';

export type KbSubsystem = {
  kb: KbRuntime;
  curateScheduler: CurateHandle;
};

type KbArgs = Record<string, unknown>;

function optionalKbSearchScope(args: KbArgs): KbSearchScope | null | undefined {
  const scope = optionalString(args, 'scope');
  if (scope === undefined) {
    return undefined;
  }

  if (scope === 'notes' || scope === 'sources' || scope === 'communities' || scope === 'all') {
    return scope;
  }

  return null;
}

function readPositiveIntegerOrDefault(args: KbArgs, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function kbErrorResult(error: unknown): ToolDomainResult {
  const detail = error instanceof Error ? { message: error.message } : error;
  return domainError('kb_error', deriveLegacyErrorMessage('kb_error', detail), detail);
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

function readRequiredOwner(owner: string): { ok: true; value: string } | { ok: false; error: ToolDomainResult } {
  try {
    return { ok: true, value: assertOwnerId(owner) };
  } catch (error: unknown) {
    return { ok: false, error: domainError('invalid_request', deriveLegacyErrorMessage('invalid_request', error)) };
  }
}

function readOptionalOwner(
  args: KbArgs,
): { ok: true; value: string | undefined } | { ok: false; error: ToolDomainResult } {
  if (!Object.hasOwn(args, 'owner')) {
    return { ok: true, value: undefined };
  }

  const rawOwner = args.owner;
  if (typeof rawOwner !== 'string') {
    return { ok: false, error: domainError('invalid_request', 'owner must be a valid token-safe identifier') };
  }

  const owner = readRequiredOwner(rawOwner);
  return owner.ok ? { ok: true, value: owner.value } : owner;
}

export async function handleKbSearch(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const query = requireString(args, 'query');
  if (query === null) {
    return domainError('invalid_request', 'query is required');
  }

  const scope = optionalKbSearchScope(args);
  if (scope === null) {
    return domainError('invalid_request', 'scope must be one of notes, sources, communities, all');
  }

  const topK = readPositiveIntegerOrDefault(args, 'top_k', 20);
  return runKbAction(() => searchKb(kbSubsystem.kb, query, topK, scope ?? 'all'));
}

export function handleKbRead(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const note = requireString(args, 'note');
  if (note === null) {
    return domainError('invalid_request', 'note is required');
  }

  return runKbSyncAction(() => readEntry({ note }, ctx.projectRoot));
}

export async function handleKbPromote(
  args: KbArgs,
  kbSubsystem: KbSubsystem,
  ctx: CallerContext,
): Promise<ToolDomainResult> {
  const memo = requireString(args, 'memo');
  const title = requireString(args, 'title');
  const content = requireString(args, 'content');
  const domain = requireString(args, 'domain');
  const topic = requireString(args, 'topic');
  if (!memo || !title || content === null || !domain || !topic) {
    return domainError('invalid_request', 'memo, title, content, domain, and topic are required strings');
  }

  return runKbAction(async () => {
    const result = await kbPromote(kbSubsystem.kb, ctx.projectRoot, { memo, title, content, domain, topic }, () => {
      kbSubsystem.curateScheduler.schedule();
    });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbUpdate(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const note = requireString(args, 'note');
  if (note === null) {
    return domainError('invalid_request', 'note is required');
  }

  return runKbAction(async () => {
    const result = await kbUpdate(kbSubsystem.kb, {
      note,
      ...(args.title !== undefined ? { title: optionalString(args, 'title') } : {}),
      ...(args.content !== undefined ? { content: optionalString(args, 'content') } : {}),
    });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbDelete(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const note = requireString(args, 'note');
  if (note === null) {
    return domainError('invalid_request', 'note is required');
  }

  return runKbAction(async () => {
    const result = await kbDeleteFn(kbSubsystem.kb, { note });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbSourceImport(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const slug = requireString(args, 'slug');
  const stagedPath = requireString(args, 'stagedPath');
  if (slug === null || stagedPath === null) {
    return domainError('invalid_request', 'slug and stagedPath are required');
  }

  return runKbAction(async () => {
    const result = await persistPreparedSource(kbSubsystem.kb, stagedPath, slug);
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbSourceList(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  void args;
  return runKbAction(() => listSources(kbSubsystem.kb));
}

export async function handleKbSourceDelete(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const slug = requireString(args, 'slug');
  if (slug === null) {
    return domainError('invalid_request', 'slug is required');
  }

  return runKbAction(async () => {
    const result = await deleteSource(kbSubsystem.kb, { slug });
    kbSubsystem.curateScheduler.scheduleDeferredCommit();
    return result;
  });
}

export async function handleKbReindex(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  void args;
  return runKbAction(() => kbReindex(kbSubsystem.kb));
}

export async function handleKbPrinciples(args: KbArgs, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const query = optionalString(args, 'query');
  const verbose = args.verbose === true;
  const topK = readPositiveIntegerOrDefault(args, 'top_k', 100);

  return runKbAction(async () => {
    const index = await kbSubsystem.kb.ensureIndex();
    const allNames = Object.keys(index.principles).sort(compareLocale);
    const total = allNames.length;
    let names = allNames;

    if (query?.trim()) {
      const loweredQuery = query.toLowerCase();
      names = allNames.filter((name) => name.toLowerCase().includes(loweredQuery));
    }

    names = names.slice(0, topK);
    if (!verbose) {
      return { principles: names, total };
    }

    const selected = new Set(names);
    const notesByPrinciple = new Map(names.map((name) => [name, [] as string[]]));
    const orphanRefs = new Set<string>();

    for (const noteRecord of Object.values(index.entries).filter(isNoteEntry).sort((left, right) =>
      compareLocale(left.slug, right.slug),
    )) {
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
}

export function handleKbMemo(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const topic = requireString(args, 'topic');
  const content = requireString(args, 'content');
  const owner = requireString(args, 'owner');
  if (!topic || content === null || owner === null) {
    return domainError('invalid_request', 'topic, content, and owner are required');
  }

  const normalizedOwner = readRequiredOwner(owner);
  if (!normalizedOwner.ok) {
    return normalizedOwner.error;
  }

  return runKbSyncAction(() => writeMemo(ctx.projectRoot, { topic, content, owner: normalizedOwner.value }));
}

export function handleKbMemoList(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const ownerFilter = readOptionalOwner(args);
  if (!ownerFilter.ok) {
    return ownerFilter.error;
  }

  return runKbSyncAction(() => listMemos(ctx.projectRoot, ownerFilter.value));
}

export function handleKbMemoDelete(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const pattern = requireString(args, 'pattern');
  if (pattern === null) {
    return domainError('invalid_request', 'pattern is required');
  }

  const deleteOwner = readOptionalOwner(args);
  if (!deleteOwner.ok) {
    return deleteOwner.error;
  }

  return runKbSyncAction(() => deleteMemos(ctx.projectRoot, { pattern, owner: deleteOwner.value }));
}

export function handleKbMemoPurge(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  const purgeOwner = readOptionalOwner(args);
  if (!purgeOwner.ok) {
    return purgeOwner.error;
  }

  return runKbSyncAction(() => purgeMemos(ctx.projectRoot, purgeOwner.value));
}
