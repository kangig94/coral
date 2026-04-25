import type { KbRuntime } from './contracts.js';
import type { KbIndex } from './entry-types.js';
import {
  buildKbIndex,
  loadCommunities,
  loadNotes,
  loadPrinciples,
  loadSources,
} from './curate/text-artifacts-loaders.js';

function buildTransientReadIndex(kb: KbRuntime): KbIndex {
  const detectedAt = new Date().toISOString();
  const { entries: notes } = loadNotes(kb, detectedAt);
  const { entries: sources } = loadSources(kb, detectedAt);
  const principles = loadPrinciples(kb);
  const communities = loadCommunities(kb);

  return buildKbIndex(kb, notes, sources, communities, principles);
}

export function readKnowledgeBaseListIndex(kb: KbRuntime): KbIndex {
  return kb.readIndex() ?? buildTransientReadIndex(kb);
}
