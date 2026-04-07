import type { CurateHandle } from '../kb/curate.js';
import type { KbRuntime } from '../kb/contracts.js';
import { ZodError, z } from 'zod';
import { deleteFn as kbDeleteFn } from '../kb/delete.js';
import { deleteMemos, listMemos, purgeMemos, writeMemo } from '../kb/memo.js';
import { promote as kbPromote } from '../kb/promote.js';
import { readEntry } from '../kb/read.js';
import { reindex as kbReindex } from '../kb/reindex.js';
import { searchKb } from '../kb/search.js';
import { deleteSource, listSources, persistPreparedSource } from '../kb/source-store.js';
import { isNoteEntry } from '../kb/types.js';
import { update as kbUpdate } from '../kb/update.js';
import { compareLocale } from '../kb/validation.js';
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

export function handleKbRead(args: KbArgs, ctx: CallerContext): ToolDomainResult {
  try {
    const parsed = kbReadSchema.parse(args);
    return runKbSyncAction(() => readEntry({ note: parsed.note }, ctx.projectRoot));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
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
    let owner: string;
    try {
      owner = assertOwnerId(parsed.owner);
    } catch (error: unknown) {
      return domainError('invalid_request', deriveLegacyErrorMessage('invalid_request', error));
    }

    return runKbSyncAction(() => writeMemo(ctx.projectRoot, { topic: parsed.topic, content: parsed.content, owner }));
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
    let owner: string | undefined;
    if (parsed.owner !== undefined) {
      try {
        owner = assertOwnerId(parsed.owner);
      } catch (error: unknown) {
        return domainError('invalid_request', deriveLegacyErrorMessage('invalid_request', error));
      }
    }

    return runKbSyncAction(() => listMemos(ctx.projectRoot, owner));
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
    let owner: string | undefined;
    if (parsed.owner !== undefined) {
      try {
        owner = assertOwnerId(parsed.owner);
      } catch (error: unknown) {
        return domainError('invalid_request', deriveLegacyErrorMessage('invalid_request', error));
      }
    }

    return runKbSyncAction(() => deleteMemos(ctx.projectRoot, { pattern: parsed.pattern, owner }));
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
    let owner: string | undefined;
    if (parsed.owner !== undefined) {
      try {
        owner = assertOwnerId(parsed.owner);
      } catch (error: unknown) {
        return domainError('invalid_request', deriveLegacyErrorMessage('invalid_request', error));
      }
    }

    return runKbSyncAction(() => purgeMemos(ctx.projectRoot, owner));
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return toolValidationError(error);
    }
    throw error;
  }
}
