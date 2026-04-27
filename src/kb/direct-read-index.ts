import type { KbRuntime } from './contract.js';
import { nowIsoString } from '../infra/time.js';
import type { KbIndex } from './entry-types.js';
import { buildCorpusScanView } from './corpus/repair/corpus-scan.js';
import {
  buildKbIndex,
  loadCommunities,
  loadNotes,
  loadPrinciples,
  loadSources,
} from './curate/text-artifacts/loaders.js';

function buildTransientReadIndex(kb: KbRuntime): KbIndex {
  const detectedAt = nowIsoString(kb.time);
  const scan = buildCorpusScanView(kb);
  const { entries: notes } = loadNotes(scan, detectedAt);
  const { entries: sources } = loadSources(scan, detectedAt);
  const principles = loadPrinciples(scan);
  const communities = loadCommunities(scan);

  return buildKbIndex(kb, notes, sources, communities, principles);
}

export function readKnowledgeBaseListIndex(kb: KbRuntime): KbIndex {
  return kb.readIndex() ?? buildTransientReadIndex(kb);
}
