import { nowIsoString } from '../../../infra/time.js';
import { captureWikiManifestDeltas } from '../../corpus/manifest-authority.js';
import { serializeWiki } from '../../corpus/frontmatter.js';
import { commitCorpusEntryLocked } from '../../corpus/index/mutations.js';
import { buildWikiIndexEntry } from '../../corpus/index/records.js';
import {
  setEntry,
  wikiEntryId,
  type KbWikiCreateInput,
  type KbWikiCreateResponse,
  type KbWikiFrontmatter,
} from '../../entry-types.js';
import { assertNonEmptyText, assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';

const EMPTY_BODY = '## Understanding\n\n\n\n## Knowledge\n\n';

function normalizeTags(values: readonly string[] | undefined): string[] {
  const tags: string[] = [];
  for (const value of values ?? []) {
    tags.push(assertNonEmptyText(value, 'tags'));
  }
  return tags;
}

export async function createWiki(rt: KbRuntime, input: KbWikiCreateInput): Promise<KbWikiCreateResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const title = input.title === undefined ? slug : assertNonEmptyText(input.title, 'title');
  const wikiPath = rt.wikiPath(slug);

  return rt.withMutationLock(async (mutation) => {
    if (rt.storagePort.existsSync(wikiPath)) {
      throw new Error(`KB wiki already exists: ${wikiPath}`);
    }

    const createdAt = nowIsoString(rt.time);
    const frontmatter: KbWikiFrontmatter = {
      tags: normalizeTags(input.tags),
      createdAt,
      updatedAt: createdAt,
    };
    const raw = serializeWiki(frontmatter, title, EMPTY_BODY);

    commitCorpusEntryLocked(rt, mutation, {
      path: wikiPath,
      raw,
      manifestDeltas: captureWikiManifestDeltas(slug, raw),
      indexUpdate: (index) => {
        setEntry(
          index,
          wikiEntryId(slug),
          buildWikiIndexEntry({
            slug,
            title,
            ...frontmatter,
            knowledge: [],
          }),
        );
      },
      lane: 'both',
      reason: 'KB text snapshot is stale after kb_wiki_create.',
    });

    return { slug, path: wikiPath };
  });
}
