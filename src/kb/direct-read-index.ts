import type { KbRuntime } from './contract.js';
import type { KbIndex } from './entry-types.js';
import { buildCorpusScanView } from './corpus/rescan/scan.js';
import { buildKbIndex, loadCommunities, loadNotes, loadPrinciples, loadSources } from './corpus/rescan/projections.js';

function buildTransientReadIndex(kb: KbRuntime): KbIndex {
  const scan = buildCorpusScanView(kb);
  const notes = loadNotes(scan);
  const sources = loadSources(scan);
  const principles = loadPrinciples(scan);
  const communities = loadCommunities(scan);

  return buildKbIndex(scan, notes, sources, communities, principles);
}

export function readKnowledgeBaseListIndex(kb: KbRuntime): KbIndex {
  return kb.readIndex() ?? buildTransientReadIndex(kb);
}
