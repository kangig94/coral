import { assertOwnerId } from '../shared/mcp-utils.js';
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
import type { ToolRequest } from './request-context.js';
import {
  deriveLegacyErrorMessage,
  domainError,
  domainSuccess,
  optionalString,
  requireString,
  type ToolDomainResult,
} from './tool-response.js';
import type { KbSubsystem } from './tool-router.js';

function optionalKbSearchScope(args: Record<string, unknown>): KbSearchScope | null | undefined {
  const scope = optionalString(args, 'scope');
  if (scope === undefined) {
    return undefined;
  }

  if (scope === 'notes' || scope === 'sources' || scope === 'communities' || scope === 'all') {
    return scope;
  }

  return null;
}

function readRequiredOwner(owner: string): { ok: true; value: string } | { ok: false; error: ToolDomainResult } {
  try {
    return { ok: true, value: assertOwnerId(owner) };
  } catch (error: unknown) {
    return { ok: false, error: domainError('invalid_request', deriveLegacyErrorMessage('invalid_request', error)) };
  }
}

function readOptionalOwner(
  args: Record<string, unknown>,
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

export async function handleKbToolCall(request: ToolRequest, kbSubsystem: KbSubsystem): Promise<ToolDomainResult> {
  const { kb } = kbSubsystem;
  const args = request.args;
  const ctx = request.context;
  try {
    let result: unknown;
    switch (request.name) {
      case 'kb_search': {
        const query = requireString(args, 'query');
        if (query === null) return domainError('invalid_request', 'query is required');
        const scope = optionalKbSearchScope(args);
        if (scope === null) {
          return domainError('invalid_request', 'scope must be one of notes, sources, communities, all');
        }

        result = await searchKb(kb, query, typeof args.top_k === 'number' ? args.top_k : 20, scope ?? 'all');
        break;
      }
      case 'kb_read': {
        const note = requireString(args, 'note');
        if (note === null) return domainError('invalid_request', 'note is required');
        result = readEntry({ note }, ctx.projectRoot);
        break;
      }
      case 'kb_promote': {
        const memo = requireString(args, 'memo');
        const title = requireString(args, 'title');
        const content = requireString(args, 'content');
        const domain = requireString(args, 'domain');
        const topic = requireString(args, 'topic');
        if (!memo || !title || content === null || !domain || !topic) {
          return domainError('invalid_request', 'memo, title, content, domain, and topic are required strings');
        }
        result = await kbPromote(kb, ctx.projectRoot, { memo, title, content, domain, topic }, () => {
          kbSubsystem.curateScheduler.schedule();
        });
        kbSubsystem.curateScheduler.scheduleDeferredCommit();
        break;
      }
      case 'kb_update': {
        const note = requireString(args, 'note');
        if (note === null) return domainError('invalid_request', 'note is required');
        result = await kbUpdate(kb, {
          note,
          ...(args.title !== undefined ? { title: optionalString(args, 'title') } : {}),
          ...(args.content !== undefined ? { content: optionalString(args, 'content') } : {}),
        });
        kbSubsystem.curateScheduler.scheduleDeferredCommit();
        break;
      }
      case 'kb_delete': {
        const note = requireString(args, 'note');
        if (note === null) return domainError('invalid_request', 'note is required');
        result = await kbDeleteFn(kb, { note });
        kbSubsystem.curateScheduler.scheduleDeferredCommit();
        break;
      }
      case 'kb_source_import': {
        const slug = requireString(args, 'slug');
        const stagedPath = requireString(args, 'stagedPath');
        if (slug === null || stagedPath === null) {
          return domainError('invalid_request', 'slug and stagedPath are required');
        }

        result = await persistPreparedSource(kb, stagedPath, slug);
        kbSubsystem.curateScheduler.scheduleDeferredCommit();
        break;
      }
      case 'kb_source_list':
        result = await listSources(kb);
        break;
      case 'kb_source_delete': {
        const slug = requireString(args, 'slug');
        if (slug === null) return domainError('invalid_request', 'slug is required');
        result = await deleteSource(kb, { slug });
        kbSubsystem.curateScheduler.scheduleDeferredCommit();
        break;
      }
      case 'kb_reindex':
        result = await kbReindex(kb);
        break;
      case 'kb_principles': {
        const index = await kb.ensureIndex();
        const verbose = args.verbose === true;
        const allNames = Object.keys(index.principles).sort(compareLocale);
        const total = allNames.length;
        const query = optionalString(args, 'query');
        let names = allNames;
        if (query?.trim()) {
          const q = query.toLowerCase();
          names = allNames.filter((name) => name.toLowerCase().includes(q));
        }
        const topK = typeof args.top_k === 'number' && Number.isInteger(args.top_k) && args.top_k > 0 ? args.top_k : 100;
        names = names.slice(0, topK);
        if (!verbose) {
          result = { principles: names, total };
          break;
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

        result = {
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
        break;
      }
      case 'kb_memo': {
        const topic = requireString(args, 'topic');
        const content = requireString(args, 'content');
        const owner = requireString(args, 'owner');
        if (!topic || content === null || owner === null)
          return domainError('invalid_request', 'topic, content, and owner are required');
        const normalizedOwner = readRequiredOwner(owner);
        if (!normalizedOwner.ok) return normalizedOwner.error;
        result = writeMemo(ctx.projectRoot, { topic, content, owner: normalizedOwner.value });
        break;
      }
      case 'kb_memo_list': {
        const ownerFilter = readOptionalOwner(args);
        if (!ownerFilter.ok) return ownerFilter.error;
        result = listMemos(ctx.projectRoot, ownerFilter.value);
        break;
      }
      case 'kb_memo_delete': {
        const pattern = requireString(args, 'pattern');
        if (pattern === null) return domainError('invalid_request', 'pattern is required');
        const deleteOwner = readOptionalOwner(args);
        if (!deleteOwner.ok) return deleteOwner.error;
        result = deleteMemos(ctx.projectRoot, { pattern, owner: deleteOwner.value });
        break;
      }
      case 'kb_memo_purge': {
        const purgeOwner = readOptionalOwner(args);
        if (!purgeOwner.ok) return purgeOwner.error;
        result = purgeMemos(ctx.projectRoot, purgeOwner.value);
        break;
      }
      default:
        return domainError('unknown_tool', `Unknown tool: ${request.name}`, { name: request.name });
    }
    return domainSuccess(result);
  } catch (error: unknown) {
    const detail = error instanceof Error ? { message: error.message } : error;
    return domainError('kb_error', deriveLegacyErrorMessage('kb_error', detail), detail);
  }
}
