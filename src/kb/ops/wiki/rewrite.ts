import type { KbWikiMutationResponse, KbWikiRewriteInput } from '../../entry-types.js';
import { assertNonEmptyText, assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import { rewriteWiki } from './mutation.js';

export async function rewriteWikiUnderstanding(
  rt: KbRuntime,
  input: KbWikiRewriteInput,
): Promise<KbWikiMutationResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const file = assertNonEmptyText(input.understandingFile, 'understandingFile');
  const understanding = rt.storagePort.readFileSync(file, 'utf-8').trim();
  return rewriteWiki(rt, slug, (current) =>
    current.sections.understanding === understanding
      ? undefined
      : {
          sections: { understanding },
          lane: 'content',
          reason: 'KB text snapshot is stale after kb_wiki_rewrite.',
        },
  );
}
