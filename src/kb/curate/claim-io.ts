import type { KbRuntime } from '../contracts.js';
import { loadKbNote, loadKbSource } from '../read.js';
import { approximateTokenCount, fingerprintEntryContent } from './shared.js';
import type { ClaimCandidate, CurateClaimedEntry } from './types.js';

const CLASSIFICATION_SOURCE_EXCERPT_TOKEN_LIMIT = 2_000;

function trimTextToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || text.length === 0) {
    return '';
  }

  if (approximateTokenCount(text) <= tokenBudget) {
    return text;
  }

  let low = 0;
  let high = text.length;
  let best = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid).trimEnd();
    if (approximateTokenCount(candidate) <= tokenBudget) {
      best = candidate;
      low = mid + 1;
      continue;
    }

    high = mid - 1;
  }

  return best;
}

function excerptSourceBody(body: string): string {
  return trimTextToTokenBudget(body, CLASSIFICATION_SOURCE_EXCERPT_TOKEN_LIMIT);
}

export function readClaimedEntry(kb: KbRuntime, candidate: ClaimCandidate): CurateClaimedEntry {
  if (candidate.kind === 'note') {
    const { title, body } = loadKbNote(kb.notePath(candidate.slug));

    return {
      kind: 'note',
      entryId: candidate.entryId,
      slug: candidate.slug,
      title,
      body,
      updatedAt: candidate.updatedAt,
      entrySeq: candidate.cursor.entrySeq,
    };
  }

  const { raw, title, body } = loadKbSource(kb.sourcePath(candidate.slug));
  return {
    kind: 'source',
    entryId: candidate.entryId,
    slug: candidate.slug,
    title,
    body: excerptSourceBody(body),
    claimTimeFingerprint: fingerprintEntryContent(raw),
    entrySeq: candidate.cursor.entrySeq,
  };
}
