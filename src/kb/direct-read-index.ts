import type { KbReadQueryRuntime } from './contract.js';
import type { KbIndex } from './entry-types.js';
import { buildCorpusScanView } from './corpus/rescan/scan.js';
import {
  buildKbIndex,
  loadCommunities,
  loadNotes,
  loadPrinciples,
  loadSources,
  loadWikis,
} from './corpus/rescan/projections.js';

function buildTransientReadIndex(kb: KbReadQueryRuntime): KbIndex {
  const scan = buildCorpusScanView(kb);
  const notes = loadNotes(scan);
  const sources = loadSources(scan);
  const principles = loadPrinciples(scan);
  const communities = loadCommunities(scan);
  const wikis = loadWikis(scan);
  const activeGeneratedCommunities = kb.generatedCommunityProjectionStore.readActiveGeneration();

  return buildKbIndex(scan, notes, sources, communities, wikis, principles, {
    generatedCommunityDocuments: activeGeneratedCommunities.records,
    generatedCommunityFreshness: {
      generatedCommunityGeneration: activeGeneratedCommunities.generatedCommunityGeneration,
      generatedCommunityDocsHash: activeGeneratedCommunities.generatedCommunityDocsHash,
    },
  });
}

export function readKnowledgeBaseListIndex(kb: KbReadQueryRuntime): KbIndex {
  return kb.readIndex() ?? buildTransientReadIndex(kb);
}
