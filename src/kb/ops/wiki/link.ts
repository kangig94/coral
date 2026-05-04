import {
  parseKnowledgeBlocks,
  serializeKnowledgeBlocks,
  type KnowledgeBlock,
} from '../../corpus/frontmatter.js';
import type { KbWikiLinkInput, KbWikiMutationResponse } from '../../entry-types.js';
import { assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import { rewriteWiki } from './mutation.js';
import { blockHeaderFor, normalizeRefs } from './knowledge.js';

export async function linkWikiKnowledge(rt: KbRuntime, input: KbWikiLinkInput): Promise<KbWikiMutationResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const refs = normalizeRefs(input.refs, 'refs');

  return rewriteWiki(rt, slug, (current) => {
    const blocks = parseKnowledgeBlocks(current.sections.knowledge);
    const present = new Set(blocks.map((block) => block.entryId));
    const additions: KnowledgeBlock[] = [];
    for (const entryId of refs) {
      if (!present.has(entryId)) {
        additions.push({ entryId, header: blockHeaderFor(entryId), evidence: [] });
        present.add(entryId);
      }
    }
    if (additions.length === 0) {
      return undefined;
    }
    return {
      sections: { knowledge: serializeKnowledgeBlocks([...blocks, ...additions]) },
      lane: 'content',
      reason: 'KB text snapshot is stale after kb_wiki_link.',
    };
  });
}
