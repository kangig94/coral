import type {
  KbCurateActiveClaimRow,
  KbCurateCommunitySummaryInputFingerprintRow,
} from '../../state/schema.js';
import type { KbRuntime } from '../../contracts.js';
import { parsePositiveInteger } from '../../validation.js';
import { readCurateDiscoveryBacklog, syncCurateDiscoveryBacklog } from '../discovery-backlog.js';
import { readCurateRetryQueue, syncCurateRetryQueue } from '../retry.js';
import {
  compareCursor,
  cursorEntryKind,
  defaultCurateState,
  kbEntryIdSchema,
  normalizeCurateStateRepairFrontier,
  type CurateState,
} from './model.js';
import { prepareCached, resolveSqliteDb } from '../sqlite.js';
import { readCurateSchedulerState, writeCurateSchedulerState } from '../state-scheduler.js';

type CurateStateTarget = Pick<KbRuntime, 'db'>;

function readActiveClaim(target: CurateStateTarget): CurateState['activeClaim'] {
  const row = prepareCached<[], KbCurateActiveClaimRow | undefined>(
    target,
    `SELECT id, through_seq, through_entry_id, through_entry_kind, started_at
       FROM kb_curate_active_claim
      WHERE id = 1`,
  ).get();
  if (row === undefined) {
    return null;
  }

  const through = {
    entryId: kbEntryIdSchema.parse(row.through_entry_id),
    entrySeq: parsePositiveInteger(row.through_seq, 'kb_curate_active_claim.through_seq'),
  };
  if (cursorEntryKind(through) !== row.through_entry_kind) {
    throw new Error('kb_curate_active_claim through_entry_kind must match the stored entry ID');
  }

  return {
    through,
    startedAt: row.started_at,
  };
}

function sameActiveClaim(left: CurateState['activeClaim'], right: CurateState['activeClaim']): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return compareCursor(left.through, right.through) === 0 && left.startedAt === right.startedAt;
}

function writeActiveClaim(target: CurateStateTarget, activeClaim: CurateState['activeClaim']): void {
  const existing = readActiveClaim(target);
  if (sameActiveClaim(existing, activeClaim)) {
    return;
  }

  if (activeClaim === null) {
    prepareCached<[]>(target, `DELETE FROM kb_curate_active_claim WHERE id = 1`).run();
    return;
  }

  const throughEntryKind = cursorEntryKind(activeClaim.through);
  if (existing === null) {
    prepareCached<[number, string, 'note' | 'source', string]>(
      target,
      `INSERT INTO kb_curate_active_claim (
         id,
         through_seq,
         through_entry_id,
         through_entry_kind,
         started_at
       ) VALUES (1, ?, ?, ?, ?)`,
    ).run(
      activeClaim.through.entrySeq,
      activeClaim.through.entryId,
      throughEntryKind,
      activeClaim.startedAt,
    );
    return;
  }

  prepareCached<[number, string, 'note' | 'source', string]>(
    target,
    `UPDATE kb_curate_active_claim
        SET through_seq = ?,
            through_entry_id = ?,
            through_entry_kind = ?,
            started_at = ?
      WHERE id = 1`,
  ).run(
    activeClaim.through.entrySeq,
    activeClaim.through.entryId,
    throughEntryKind,
    activeClaim.startedAt,
  );
}

function readCommunitySummaryInputFingerprints(target: CurateStateTarget): Record<string, string> | undefined {
  const rows = prepareCached<[], KbCurateCommunitySummaryInputFingerprintRow>(
    target,
    `SELECT community_slug, fingerprint
       FROM kb_curate_community_summary_input_fingerprints
      ORDER BY community_slug ASC`,
  ).all();
  if (rows.length === 0) {
    return undefined;
  }

  return Object.fromEntries(rows.map(({ community_slug, fingerprint }) => [community_slug, fingerprint]));
}

function writeCommunitySummaryInputFingerprints(
  target: CurateStateTarget,
  fingerprints: Record<string, string> | undefined,
): void {
  const existing = readCommunitySummaryInputFingerprints(target) ?? {};
  const next = fingerprints ?? {};

  for (const communitySlug of Object.keys(existing)) {
    if (!(communitySlug in next)) {
      prepareCached<[string]>(
        target,
        `DELETE FROM kb_curate_community_summary_input_fingerprints
          WHERE community_slug = ?`,
      ).run(communitySlug);
    }
  }

  for (const [communitySlug, fingerprint] of Object.entries(next).sort(([left], [right]) => left.localeCompare(right))) {
    if (!(communitySlug in existing)) {
      prepareCached<[string, string]>(
        target,
        `INSERT INTO kb_curate_community_summary_input_fingerprints (
           community_slug,
           fingerprint
         ) VALUES (?, ?)`,
      ).run(communitySlug, fingerprint);
      continue;
    }

    if (existing[communitySlug] !== fingerprint) {
      prepareCached<[string, string]>(
        target,
        `UPDATE kb_curate_community_summary_input_fingerprints
            SET fingerprint = ?
          WHERE community_slug = ?`,
      ).run(fingerprint, communitySlug);
    }
  }
}

export function readCurateState(target: CurateStateTarget): CurateState {
  const scheduler = readCurateSchedulerState(target);
  const retryQueue = readCurateRetryQueue(target);
  const state = normalizeCurateStateRepairFrontier({
    ...defaultCurateState(),
    processedThrough: scheduler.processedThrough,
    discoveryHighSeq: scheduler.discoveryHighSeq,
    discoveryOffset: scheduler.discoveryOffset,
    lastRunDay: scheduler.lastRunDay,
    lastAttemptedThrough: scheduler.lastAttemptedThrough,
    retryNotBefore: scheduler.retryNotBefore,
    activeClaim: readActiveClaim(target),
    pendingDiscoveries: readCurateDiscoveryBacklog(target),
    pendingRepair: retryQueue.length === 0 ? null : retryQueue,
    communityTopologyHash: scheduler.communityTopologyHash,
    communitySummaryTopologyHash: scheduler.communitySummaryTopologyHash,
    communitySummaryInputFingerprints: readCommunitySummaryInputFingerprints(target),
    consecutiveClaimFailures: scheduler.consecutiveClaimFailures,
    consecutiveCommunityBatchFailures: scheduler.consecutiveCommunityBatchFailures,
    initialized: scheduler.initialized,
  });

  return state;
}

export function writeCurateState(target: CurateStateTarget, state: CurateState): void {
  const normalized = normalizeCurateStateRepairFrontier(state);
  const db = resolveSqliteDb(target);
  db.transaction(() => {
    writeCurateSchedulerState(target, {
      processedThrough: normalized.processedThrough,
      discoveryHighSeq: normalized.discoveryHighSeq,
      discoveryOffset: normalized.discoveryOffset,
      lastRunDay: normalized.lastRunDay,
      lastAttemptedThrough: normalized.lastAttemptedThrough,
      retryNotBefore: normalized.retryNotBefore,
      consecutiveClaimFailures: normalized.consecutiveClaimFailures,
      consecutiveCommunityBatchFailures: normalized.consecutiveCommunityBatchFailures,
      communityTopologyHash: normalized.communityTopologyHash,
      communitySummaryTopologyHash: normalized.communitySummaryTopologyHash,
      initialized: normalized.initialized,
    });
    syncCurateRetryQueue(target, normalized.pendingRepair ?? []);
    syncCurateDiscoveryBacklog(target, normalized.pendingDiscoveries);
    writeActiveClaim(target, normalized.activeClaim);
    writeCommunitySummaryInputFingerprints(target, normalized.communitySummaryInputFingerprints);
  })();
}
