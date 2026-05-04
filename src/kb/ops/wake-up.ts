import { join } from 'node:path';

import type { Database } from '../../store/db.js';
import type { CorpusApplyResult, CorpusConsumerRegistration } from '../../store/consumer-contract.js';
import type { KbCorpusSnapshot, KbRuntime } from '../contract.js';
import { curateDb } from '../curate/db-access.js';
import { parseWikiBody } from '../corpus/frontmatter.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import type { CorpusSnapshotCursorRow } from '../state/corpus-state.js';
import { normalizeCorpusCursor, readCorpusState } from '../state/corpus-state.js';
import type { KbProjectionInput, KbProjectionRecord } from '../projection-input-contract.js';

export const WAKE_UP_CONSUMER_ID = 'kb.wake-up';
/**
 * Conservative fallback for the default ~900-token wake-up target. Without an
 * exact tokenizer, Korean/Chinese-heavy packets can still land around 1.2-1.7x
 * the target; the exact-tokenizer path should replace this byte cap when added.
 */
export const WAKE_UP_FALLBACK_MAX_BYTES = 3500;
export const WAKE_UP_DEFAULT_TOKEN_BUDGET = 900;
export const WAKE_UP_MAX_WIKIS = 100;

const STALE_RESULT: CorpusApplyResult = { advance: false, reason: 'stale-snapshot' };

const STAMP_PATTERN =
  /^<!-- corpus-snapshot: snapshotId=(\S*) contentSeq=(\d+) metadataSeq=(\d+) contentManifestHash=(\S*) metadataManifestHash=(\S*) -->\r?\n?/;

type WakeUpRuntime = Pick<
  KbRuntime,
  'runtimeDir' | 'markdownRoot' | 'storagePort' | 'ids' | 'wikiPath' | 'readIndexOrEmpty'
>;

export function wakeUpPacketPath(kb: Pick<KbRuntime, 'runtimeDir'>): string {
  return join(kb.runtimeDir, 'wake-up.md');
}

export function formatCorpusSnapshotStamp(snapshot: KbCorpusSnapshot): string {
  return `<!-- corpus-snapshot: snapshotId=${snapshot.snapshotId} contentSeq=${snapshot.contentSeq} metadataSeq=${snapshot.metadataSeq} contentManifestHash=${snapshot.contentManifestHash} metadataManifestHash=${snapshot.metadataManifestHash} -->`;
}

export function parseCorpusSnapshotStamp(content: string): KbCorpusSnapshot | null {
  const match = content.match(STAMP_PATTERN);
  if (match === null) {
    return null;
  }

  return {
    snapshotId: match[1],
    contentSeq: Number.parseInt(match[2], 10),
    metadataSeq: Number.parseInt(match[3], 10),
    contentManifestHash: match[4],
    metadataManifestHash: match[5],
  };
}

export function sameCorpusSnapshot(left: KbCorpusSnapshot, right: KbCorpusSnapshot): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.contentSeq === right.contentSeq &&
    left.metadataSeq === right.metadataSeq &&
    left.contentManifestHash === right.contentManifestHash &&
    left.metadataManifestHash === right.metadataManifestHash
  );
}

export function truncateWakeUpPacket(packetBody: string, tokenBudget = WAKE_UP_DEFAULT_TOKEN_BUDGET): string {
  const byteCap = fallbackByteCap(tokenBudget);
  if (byteCap <= 0 || packetBody.length === 0) {
    return '';
  }
  if (Buffer.byteLength(packetBody, 'utf8') <= byteCap) {
    return packetBody;
  }

  let used = 0;
  const chars: string[] = [];
  for (const char of packetBody) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (used + bytes > byteCap) {
      break;
    }
    chars.push(char);
    used += bytes;
  }
  return chars.join('').trimEnd();
}

function fallbackByteCap(tokenBudget: number): number {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return 0;
  }
  return Math.min(
    WAKE_UP_FALLBACK_MAX_BYTES,
    Math.floor((tokenBudget * WAKE_UP_FALLBACK_MAX_BYTES) / WAKE_UP_DEFAULT_TOKEN_BUDGET),
  );
}

function readIdentity(kb: Pick<WakeUpRuntime, 'markdownRoot' | 'storagePort'>): string | null {
  const identityPath = join(kb.markdownRoot, 'identity.md');
  if (!kb.storagePort.existsSync(identityPath)) {
    return null;
  }
  return kb.storagePort.readFileSync(identityPath, 'utf-8').trimEnd();
}

function extractFirstParagraph(section: string): string {
  return (
    section
      .trim()
      .split(/\r?\n[ \t]*\r?\n/)
      .map((paragraph) => paragraph.trim())
      .find((paragraph) => paragraph.length > 0) ?? ''
  );
}

function sortedWakeUpWikiRecords(
  projectionInput: KbProjectionInput,
): Array<Extract<KbProjectionRecord, { kind: 'wiki' }>> {
  return projectionInput.records
    .filter((record): record is Extract<KbProjectionRecord, { kind: 'wiki' }> => record.kind === 'wiki')
    .sort(
      (left, right) =>
        right.entry.updatedAt.localeCompare(left.entry.updatedAt) || left.entry.slug.localeCompare(right.entry.slug),
    )
    .slice(0, WAKE_UP_MAX_WIKIS);
}

function renderWakeUpBody(kb: WakeUpRuntime, projectionInput: KbProjectionInput, tokenBudget: number): string {
  const identity = readIdentity(kb);
  const wikiChunks = sortedWakeUpWikiRecords(projectionInput)
    .map((record) => {
      const sections = parseWikiBody(record.body);
      const paragraph = extractFirstParagraph(sections.understanding);
      return `## ${record.entry.slug} (${record.entry.updatedAt})\n${paragraph}\n`;
    })
    .join('');

  const packetBody = identity === null || identity.length === 0 ? wikiChunks : `${identity}\n\n${wikiChunks}`;
  return truncateWakeUpPacket(packetBody, tokenBudget);
}

interface BuildWakeUpOptions {
  readonly snapshot: KbCorpusSnapshot;
  readonly tokenBudget: number;
}

/**
 * Single packet renderer shared by the corpus consumer apply() path and the
 * `generateWakeUpPacket` on-demand entry point. Both must observe the same
 * projection-input contract — drift here previously meant the cached packet
 * could disagree with the on-demand packet for the same snapshot.
 */
function buildWakeUpFromProjectionInput(
  kb: WakeUpRuntime,
  projectionInput: KbProjectionInput,
  opts: BuildWakeUpOptions,
): string {
  return `${formatCorpusSnapshotStamp(opts.snapshot)}\n${renderWakeUpBody(kb, projectionInput, opts.tokenBudget)}`;
}

function readCurrentSnapshot(kb: KbRuntime): KbCorpusSnapshot {
  return readCorpusState(curateDb(kb));
}

function readWakeUpConsumerCursor(kb: KbRuntime): KbCorpusSnapshot | null {
  const db: Database = curateDb(kb);

  const row = db
    .prepare<[string], CorpusSnapshotCursorRow>(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM consumer_cursors
         WHERE consumer_id = ?
      `,
    )
    .get(WAKE_UP_CONSUMER_ID);
  return row === undefined ? null : normalizeCorpusCursor(row);
}

function readFreshCachedWakeUpPacket(kb: KbRuntime, snapshot: KbCorpusSnapshot): string | null {
  const cursor = readWakeUpConsumerCursor(kb);
  if (cursor === null || !sameCorpusSnapshot(cursor, snapshot)) {
    return null;
  }

  const path = wakeUpPacketPath(kb);
  if (!kb.storagePort.existsSync(path)) {
    return null;
  }

  const cached = kb.storagePort.readFileSync(path, 'utf-8');
  const stamp = parseCorpusSnapshotStamp(cached);
  return stamp !== null && sameCorpusSnapshot(stamp, snapshot) ? cached : null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Wake-up corpus consumer aborted.');
  }
}

export function createWakeUpCorpusConsumer(kb: KbRuntime): CorpusConsumerRegistration {
  return {
    id: WAKE_UP_CONSUMER_ID,
    authority: 'corpus',
    kind: 'apply',
    registrationKind: 'base',
    corpusInterest: 'both',
    async apply({ snapshot, corpusStateReader, projectionInput, signal }) {
      throwIfAborted(signal);
      if (!sameCorpusSnapshot(corpusStateReader.readCurrentSnapshot(), snapshot)) {
        return STALE_RESULT;
      }

      const packet = buildWakeUpFromProjectionInput(kb, projectionInput, {
        snapshot,
        tokenBudget: WAKE_UP_DEFAULT_TOKEN_BUDGET,
      });

      throwIfAborted(signal);
      if (!sameCorpusSnapshot(corpusStateReader.readCurrentSnapshot(), snapshot)) {
        return STALE_RESULT;
      }

      writeFileAtomic(kb, wakeUpPacketPath(kb), packet);

      throwIfAborted(signal);
      if (!sameCorpusSnapshot(corpusStateReader.readCurrentSnapshot(), snapshot)) {
        return STALE_RESULT;
      }

      return undefined;
    },
  };
}

export async function generateWakeUpPacket(
  kb: KbRuntime,
  tokenBudget = WAKE_UP_DEFAULT_TOKEN_BUDGET,
): Promise<string> {
  const initialSnapshot = readCurrentSnapshot(kb);
  const cached = readFreshCachedWakeUpPacket(kb, initialSnapshot);
  if (cached !== null) {
    return cached;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = readCurrentSnapshot(kb);
    // Use the same projection-input contract the corpus consumer apply() sees,
    // so the cached and on-demand packets can never disagree for one snapshot.
    const projectionInput = await kb.corpusProjectionReader.prepareCurrentProjectionInput();
    if (!sameCorpusSnapshot(readCurrentSnapshot(kb), snapshot)) {
      continue;
    }

    const packet = buildWakeUpFromProjectionInput(kb, projectionInput, { snapshot, tokenBudget });
    if (!sameCorpusSnapshot(readCurrentSnapshot(kb), snapshot)) {
      continue;
    }

    writeFileAtomic(kb, wakeUpPacketPath(kb), packet);
    if (!sameCorpusSnapshot(readCurrentSnapshot(kb), snapshot)) {
      continue;
    }

    return packet;
  }

  throw new Error('Wake-up packet generation aborted due to stale corpus snapshot.');
}
