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
import { optionalString, requireString, toolError, toolSuccess } from './tool-response.js';
import type { KbSubsystem, ToolRouteResponse } from './tool-router.js';

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

export async function handleKbToolCall(request: ToolRequest, kbSubsystem: KbSubsystem): Promise<ToolRouteResponse> {
  const { kb } = kbSubsystem;
  const args = request.args;
  const ctx = request.context;
  try {
    let result: unknown;
    switch (request.name) {
      case 'kb_search': {
        const query = requireString(args, 'query');
        if (query === null) return toolError('invalid_request', { message: 'query is required' });
        const scope = optionalKbSearchScope(args);
        if (scope === null) {
          return toolError('invalid_request', { message: 'scope must be one of notes, sources, communities, all' });
        }

        result = await searchKb(kb, query, typeof args.top_k === 'number' ? args.top_k : 20, scope ?? 'all');
        break;
      }
      case 'kb_read': {
        const note = requireString(args, 'note');
        if (note === null) return toolError('invalid_request', { message: 'note is required' });
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
          return toolError('invalid_request', {
            message: 'memo, title, content, domain, and topic are required strings',
          });
        }
        result = await kbPromote(kb, ctx.projectRoot, { memo, title, content, domain, topic }, () => {
          kbSubsystem.curateScheduler.schedule();
        });
        kbSubsystem.curateScheduler.scheduleDeferredCommit();
        break;
      }
      case 'kb_update': {
        const note = requireString(args, 'note');
        if (note === null) return toolError('invalid_request', { message: 'note is required' });
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
        if (note === null) return toolError('invalid_request', { message: 'note is required' });
        result = await kbDeleteFn(kb, { note });
        kbSubsystem.curateScheduler.scheduleDeferredCommit();
        break;
      }
      case 'kb_source_import': {
        const slug = requireString(args, 'slug');
        const stagedPath = requireString(args, 'stagedPath');
        if (slug === null || stagedPath === null) {
          return toolError('invalid_request', {
            message: 'slug and stagedPath are required',
          });
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
        if (slug === null) return toolError('invalid_request', { message: 'slug is required' });
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
        const topK = typeof args.top_k === 'number' ? args.top_k : 100;
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
          return toolError('invalid_request', { message: 'topic, content, and owner are required' });
        const normalizedOwner = assertOwnerId(owner);
        result = writeMemo(ctx.projectRoot, { topic, content, owner: normalizedOwner });
        break;
      }
      case 'kb_memo_list': {
        const ownerFilter = optionalString(args, 'owner');
        result = listMemos(ctx.projectRoot, ownerFilter);
        break;
      }
      case 'kb_memo_delete': {
        const pattern = requireString(args, 'pattern');
        if (pattern === null) return toolError('invalid_request', { message: 'pattern is required' });
        const deleteOwner = optionalString(args, 'owner');
        result = deleteMemos(ctx.projectRoot, { pattern, owner: deleteOwner });
        break;
      }
      case 'kb_memo_purge':
        result = purgeMemos(ctx.projectRoot, optionalString(args, 'owner'));
        break;
      default:
        return { statusCode: 404, body: { error: 'unknown_tool', name: request.name } };
    }
    return toolSuccess(result);
  } catch (error: unknown) {
    return toolError('kb_error', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
