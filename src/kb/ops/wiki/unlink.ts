import { parseKnowledgeBlocks, serializeKnowledgeBlocks, type KnowledgeBlock } from '../../corpus/frontmatter.js';
import type { KbWikiMutationResponse, KbWikiUnlinkInput } from '../../entry-types.js';
import { assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import { rewriteWiki } from './mutation.js';
import { normalizeRefs } from './knowledge.js';

export async function unlinkWikiKnowledge(rt: KbRuntime, input: KbWikiUnlinkInput): Promise<KbWikiMutationResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const refs = normalizeRefs(input.refs, 'refs');
  const removals = new Set(refs);

  return rewriteWiki(rt, slug, (current) => {
    const blocks = parseKnowledgeBlocks(current.sections.knowledge);
    const filtered: KnowledgeBlock[] = [];
    for (const block of blocks) {
      if (!removals.has(block.entryId)) {
        filtered.push(block);
      }
    }
    if (filtered.length === blocks.length) {
      return undefined;
    }
    return {
      sections: { knowledge: serializeKnowledgeBlocks(filtered) },
      lane: 'content',
      reason: 'KB text snapshot is stale after kb_wiki_unlink.',
    };
  });
}
