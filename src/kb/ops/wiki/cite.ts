import { parseKnowledgeBlocks, serializeKnowledgeBlocks } from '../../corpus/frontmatter.js';
import { entryIdToVaultLink, type KbWikiCiteInput, type KbWikiMutationResponse } from '../../entry-types.js';
import { assertNonEmptyText, assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import { rewriteWiki } from './mutation.js';
import { normalizeRef } from './knowledge.js';

export async function citeWikiKnowledge(rt: KbRuntime, input: KbWikiCiteInput): Promise<KbWikiMutationResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const targetId = normalizeRef(input.ref, 'ref');
  const file = assertNonEmptyText(input.evidenceFile, 'evidenceFile');
  const evidenceText = rt.storagePort.readFileSync(file, 'utf-8').trim();
  if (evidenceText.length === 0) {
    throw new Error('evidence file is empty');
  }

  return rewriteWiki(rt, slug, (current) => {
    const blocks = parseKnowledgeBlocks(current.sections.knowledge);
    const targetIndex = blocks.findIndex((block) => block.entryId === targetId);
    if (targetIndex === -1) {
      throw new Error(
        `${entryIdToVaultLink(targetId)} is not in the Knowledge section — link it first with 'kb wiki link'`,
      );
    }
    const next = blocks.map((block, index) =>
      index === targetIndex ? { ...block, evidence: [...block.evidence, `  - ${evidenceText}`] } : block,
    );
    return {
      sections: { knowledge: serializeKnowledgeBlocks(next) },
      lane: 'content',
      reason: 'KB text snapshot is stale after kb_wiki_cite.',
    };
  });
}
