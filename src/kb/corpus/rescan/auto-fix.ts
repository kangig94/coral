import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage } from '../../../infra/error-format.js';
import { nowIsoString } from '../../../infra/time.js';
import type { KbMutationEffects, KbRuntime } from '../../contract.js';
import {
  captureCommunityManifestDelta,
  captureNoteManifestDeltas,
  capturePrincipleManifestDelta,
  captureSourceManifestDeltas,
} from '../manifest-authority.js';
import type { ManifestAuthorityDelta } from '../manifest-types.js';
import {
  communityEntryId,
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type KbEntryId,
  type KbIndex,
} from '../../entry-types.js';
import { stripMdExt } from '../../paths.js';
import type { GitSyncController } from '../../curate/git-sync.js';
import { deleteCurateRetryEntry, upsertCurateRetryEntry } from '../../curate/retry.js';
import { writeFileAtomic } from '../file-atomic.js';
import {
  commitIndexUpdate,
  recordContentAndMetadataMutation,
  recordMetadataMutation,
} from '../index-mutations.js';
import {
  buildCommunityIndexEntry,
  buildNoteIndexEntry,
  buildSourceIndexEntry,
} from '../index-records.js';
import { sortedMarkdownEntries } from '../markdown-entries.js';
import {
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseCommunityFrontmatter,
  parseFrontmatter,
  parseMembersFromBody,
  parseSourceFrontmatter,
  parseSummaryFromBody,
} from '../frontmatter.js';
import {
  classifyIncident,
  REPAIR_INCIDENT_ID,
  type DetectedIncident,
  type IncidentClassification,
  type RepairIncidentId,
} from './incidents/catalog.js';

const ENTRYSEQ_QUOTED_DECIMAL_PATTERN =
  /(^|\r?\n)(\s*entrySeq:\s*)(["'])([0-9]+)\3(\s*(?:#.*)?)(?=\r?\n|$)/;
const ENTRYSEQ_LEADING_ZERO_PATTERN =
  /(^|\r?\n)(\s*entrySeq:\s*)(0[0-9]+)(\s*(?:#.*)?)(?=\r?\n|$)/;
const LENIENT_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)(?:\r?\n---(?:\r?\n|$)|$)/;
const LENIENT_ENTRYSEQ_PATTERN = /(?:^|\r?\n)\s*entrySeq:\s*(?:['"])?(\d+)(?:['"])?\s*(?:#.*)?(?=\r?\n|$)/;

type RepairAction = 'fixed' | 'enqueued' | 'skipped';

export interface RepairResult {
  locus: DetectedIncident['locus'];
  canonical: DetectedIncident['canonical'];
  entryId: string;
  action: RepairAction;
  timestamp: string;
}

type MarkdownRepairTarget =
  | {
      kind: 'note';
      slug: string;
      entryId: KbEntryId;
      path: string;
      content: string;
    }
  | {
      kind: 'source';
      slug: string;
      entryId: KbEntryId;
      path: string;
      content: string;
    }
  | {
      kind: 'community';
      slug: string;
      entryId: KbEntryId;
      path: string;
      content: string;
    }
  | {
      kind: 'principle';
      slug: string;
      entryId: `principle:${string}`;
      path: string;
      content: string;
    };

type PreparedMarkdownFix = {
  content: string;
  updateIndex(index: KbIndex): void;
};

type LockedAutoFixOutcome = { kind: 'fixed' } | { kind: 'manual' } | { kind: 'skipped' };

export const REPAIR_HINTS = {
  [REPAIR_INCIDENT_ID.FILE_SYNTAX.CONFLICT_MARKERS]: 'Resolve the merge conflict and keep one authoritative document.',
  [REPAIR_INCIDENT_ID.FILE_SYNTAX.MALFORMED_MARKDOWN]:
    'Repair markdown structure manually and leave the file with balanced fences and valid headings.',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.UNTERMINATED_YAML]:
    'Close the YAML frontmatter at the correct boundary and ensure markdown body starts after it.',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.YAML_PARSE_ERROR]:
    'Repair YAML syntax manually until the top-level frontmatter parses as a mapping.',
  [REPAIR_INCIDENT_ID.FRONTMATTER_SHAPE.MISSING_REQUIRED_FIELDS]:
    'Restore the missing required identity fields without inventing new authority.',
  [REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_COLLISION]:
    'Resolve the conflicting entrySeq ownership manually so only one entry claims each positive integer.',
  [REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT]:
    'Normalize entrySeq to one unquoted positive base-10 integer token.',
  [REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS]:
    'Remove evidence references that no longer point at active corpus entries.',
  [REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_PRINCIPLE_REFS]:
    'Remove missing principle references from note frontmatter or restore the principle documents.',
} as const satisfies Readonly<Record<RepairIncidentId, string>>;

const AUTO_FIX_HANDLERS: Readonly<
  Partial<Record<RepairIncidentId, (kb: KbRuntime, mutation: KbMutationEffects, incident: DetectedIncident) => LockedAutoFixOutcome>>
> = {
  [REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT]: (kb: KbRuntime, mutation: KbMutationEffects, incident: DetectedIncident) =>
    applyEntrySeqFormatFixLocked(kb, mutation, incident),
  [REPAIR_INCIDENT_ID.REFERENCE_INTEGRITY.ORPHAN_ENTITY_GRAPH_REFS]: (kb: KbRuntime, mutation: KbMutationEffects) =>
    applyOrphanEntityGraphFixLocked(kb, mutation),
};

/**
 * Applies deterministic KB repair actions and queues manual follow-up when automation must stop.
 *
 * @precondition Caller already holds `kb.withMutationLock()` and supplies the `mutation` context
 * captured by that lock. The caller also constructs the `gitSync` controller from production ports
 * (KbRuntime carries `storagePort`/`processPort`/`envPort`/`spawnCli`); auto-fix never reaches the
 * lock-acquiring surface, so reentrant deadlock is structurally impossible.
 */
export async function applyDetectedIncidentFixesLocked(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  gitSync: Pick<GitSyncController, 'scheduleDeferredCommit'>,
  incidents: readonly DetectedIncident[],
): Promise<RepairResult[]> {
  const results: RepairResult[] = [];

  for (const incident of incidents) {
    let result: RepairResult;

    try {
      const classification = resolveRepairClassification(incident);
      if (classification === 'auto-fixable') {
        const outcome = applyAutoFixLocked(kb, mutation, incident);
        if (outcome.kind === 'fixed') {
          gitSync.scheduleDeferredCommit();
          result = createRepairResult(incident, 'fixed', nowIsoString(kb.time));
        } else if (outcome.kind === 'manual') {
          const enqueued = enqueueManualRepairLocked(kb, incident);
          result = createRepairResult(incident, enqueued ? 'enqueued' : 'skipped', nowIsoString(kb.time));
        } else {
          result = createRepairResult(incident, 'skipped', nowIsoString(kb.time));
        }
      } else if (classification === 'needs-manual') {
        const enqueued = enqueueManualRepairLocked(kb, incident);
        result = createRepairResult(incident, enqueued ? 'enqueued' : 'skipped', nowIsoString(kb.time));
      } else {
        result = createRepairResult(incident, 'skipped', nowIsoString(kb.time));
      }
    } catch (error: unknown) {
      backendLog.warn(
        `kb_repair_error ${JSON.stringify({
          locus: incident.locus,
          canonical: incident.canonical,
          entryId: incident.entryId,
          message: errorMessage(error),
          timestamp: nowIsoString(kb.time),
        })}`,
      );
      result = createRepairResult(incident, 'skipped', nowIsoString(kb.time));
    }

    logRepairResult(result);
    results.push(result);
  }

  return results;
}

function createRepairResult(incident: DetectedIncident, action: RepairAction, timestamp: string): RepairResult {
  return {
    locus: incident.locus,
    canonical: incident.canonical,
    entryId: incident.entryId,
    action,
    timestamp,
  };
}

function logRepairResult(result: RepairResult): void {
  const message = JSON.stringify(result);
  if (result.action === 'skipped') {
    backendLog.warn(message);
    return;
  }

  backendLog.info(message);
}

function resolveRepairClassification(incident: DetectedIncident): IncidentClassification {
  if (
    incident.canonical === REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT &&
    !isNormalizableEntrySeqIncident(incident)
  ) {
    return 'needs-manual';
  }

  return classifyIncident(incident);
}

function isNormalizableEntrySeqIncident(incident: DetectedIncident): boolean {
  const reasons = incident.signals['reasons'];
  if (!Array.isArray(reasons)) {
    return false;
  }

  const normalizedValue = incident.signals['normalizedValue'];
  if (typeof normalizedValue !== 'number' || !Number.isSafeInteger(normalizedValue) || normalizedValue < 1) {
    return false;
  }

  return reasons.length >= 1 && reasons.every((reason) => reason === 'quoted-decimal' || reason === 'leading-zeros');
}

function applyAutoFixLocked(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  incident: DetectedIncident,
): LockedAutoFixOutcome {
  const handler = AUTO_FIX_HANDLERS[incident.canonical];
  return handler === undefined ? { kind: 'manual' } : handler(kb, mutation, incident);
}

function applyEntrySeqFormatFixLocked(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  incident: DetectedIncident,
): LockedAutoFixOutcome {
  if (!isNormalizableEntrySeqIncident(incident)) {
    return { kind: 'manual' };
  }

  const target = resolveMarkdownRepairTarget(kb, incident.entryId);
  if (target === null || target.kind === 'principle') {
    return { kind: 'skipped' };
  }

  const normalizedQuoted = target.content.replace(
    ENTRYSEQ_QUOTED_DECIMAL_PATTERN,
    (_match, prefix: string, label: string, _quote: string, digits: string, suffix: string) =>
      `${prefix}${label}${Number.parseInt(digits, 10)}${suffix}`,
  );
  const replacement = normalizedQuoted.replace(
    ENTRYSEQ_LEADING_ZERO_PATTERN,
    (_match, prefix: string, label: string, digits: string, suffix: string) =>
      `${prefix}${label}${Number.parseInt(digits, 10)}${suffix}`,
  );

  if (replacement === target.content) {
    return { kind: 'manual' };
  }

  const prepared = prepareMarkdownFix(target, replacement);
  if (prepared === null) {
    return { kind: 'manual' };
  }

  applyPreparedMarkdownFixLocked(kb, mutation, target, prepared, 'metadata', 'KB metadata snapshot is stale after kb_repair.');
  return { kind: 'fixed' };
}

function applyOrphanEntityGraphFixLocked(kb: KbRuntime, mutation: KbMutationEffects): LockedAutoFixOutcome {
  const currentGraph = kb.readEntityGraph();
  if (currentGraph === null) {
    return { kind: 'skipped' };
  }

  const activeEntryIds = collectActiveCorpusEntryIds(kb);
  let changed = false;
  const nextRelationships = currentGraph.relationships.flatMap((relationship) => {
    const dedupedEvidence = dedupe(
      relationship.evidence.filter((reference) => {
        const normalized = parseKbEntryId(reference);
        const keep = normalized !== null && activeEntryIds.has(normalized);
        if (!keep) {
          changed = true;
        }
        return keep;
      }),
    );

    if (dedupedEvidence.length === 0) {
      changed = true;
      return [];
    }

    if (dedupedEvidence.length !== relationship.evidence.length) {
      changed = true;
    }

    return [
      {
        ...relationship,
        evidence: dedupedEvidence,
      },
    ];
  });

  if (!changed) {
    return { kind: 'skipped' };
  }

  mutation.writeEntityGraph({
    entityMeta: currentGraph.entityMeta,
    relationships: nextRelationships,
  });
  return { kind: 'fixed' };
}

function prepareMarkdownFix(target: MarkdownRepairTarget, content: string): PreparedMarkdownFix | null {
  try {
    return {
      content,
      updateIndex: buildIndexUpdater(target, content),
    };
  } catch {
    return null;
  }
}

function buildIndexUpdater(target: MarkdownRepairTarget, content: string): (index: KbIndex) => void {
  switch (target.kind) {
    case 'note': {
      const frontmatter = parseFrontmatter(content);
      const title = extractTitle(content);
      return (index) => {
        index.entries[target.entryId] = buildNoteIndexEntry({
          slug: target.slug,
          title,
          ...frontmatter,
        });
      };
    }
    case 'source': {
      const frontmatter = parseSourceFrontmatter(content);
      return (index) => {
        index.entries[target.entryId] = buildSourceIndexEntry({
          slug: target.slug,
          ...frontmatter,
        });
      };
    }
    case 'community': {
      const frontmatter = parseCommunityFrontmatter(content);
      const title = extractTitle(content);
      const body = extractBody(content);
      const members = parseMembersFromBody(body);
      const summary = parseSummaryFromBody(body);
      return (index) => {
        index.entries[target.entryId] = buildCommunityIndexEntry({
          slug: target.slug,
          title,
          members,
          summary,
          ...frontmatter,
        });
      };
    }
    case 'principle': {
      const statement = extractPrincipleStatement(content);
      return (index) => {
        index.principles[target.slug] = statement;
      };
    }
  }
}

function applyPreparedMarkdownFixLocked(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  target: MarkdownRepairTarget,
  prepared: PreparedMarkdownFix,
  mutationLane: 'both' | 'metadata',
  reason: string,
): void {
  writeFileAtomic(target.path, prepared.content);
  mutation.queueManifestAuthorityDelta(captureRepairTargetManifestDeltas(target, prepared.content));
  commitIndexUpdate(kb, prepared.updateIndex);

  const queueEntryId = parseKbEntryId(target.entryId);
  if (queueEntryId !== null) {
    deleteCurateRetryEntry(kb, queueEntryId);
  }

  if (mutationLane === 'metadata') {
    recordMetadataMutation(kb, reason);
  } else {
    recordContentAndMetadataMutation(kb, reason);
  }
}

function captureRepairTargetManifestDeltas(
  target: MarkdownRepairTarget,
  content: string,
): ManifestAuthorityDelta[] {
  switch (target.kind) {
    case 'note':
      return captureNoteManifestDeltas(target.slug, content);
    case 'source':
      return captureSourceManifestDeltas(target.slug, content);
    case 'community':
      return captureCommunityManifestDelta(target.slug, content);
    case 'principle':
      return capturePrincipleManifestDelta(target.slug, content);
  }
}

function enqueueManualRepairLocked(kb: KbRuntime, incident: DetectedIncident): boolean {
  const entryId = parseKbEntryId(incident.entryId);
  if (entryId === null) {
    return false;
  }

  const target = resolveMarkdownRepairTarget(kb, incident.entryId);
  const content = target?.content ?? null;
  // observedContentHash lets the rescan drift gate skip re-detection until the file content changes;
  // typed-incident enqueues record it so a re-running rebuild does not re-fire the same incident.
  const observedContentHash = content === null ? undefined : createHash('sha256').update(content, 'utf8').digest('hex');

  const now = nowIsoString(kb.time);
  upsertCurateRetryEntry(kb, {
    entryId,
    entrySeq: readLenientEntrySeq(content),
    detectedAt: now,
    ...(observedContentHash === undefined ? {} : { observedContentHash }),
    reason: incident.canonical,
    locus: incident.locus,
    canonicalIncident: incident.canonical,
    signalsJson: JSON.stringify(incident.signals),
    repairHint: REPAIR_HINTS[incident.canonical],
    retryNotBefore: now,
    retryCount: 0,
  });
  return true;
}

function resolveMarkdownRepairTarget(kb: KbRuntime, entryId: string): MarkdownRepairTarget | null {
  if (entryId.startsWith('note:')) {
    const slug = entryId.slice('note:'.length);
    return readMarkdownRepairTarget(kb.notePath(slug), {
      kind: 'note',
      slug,
      entryId: noteEntryId(slug),
    });
  }

  if (entryId.startsWith('source:')) {
    const slug = entryId.slice('source:'.length);
    return readMarkdownRepairTarget(kb.sourcePath(slug), {
      kind: 'source',
      slug,
      entryId: sourceEntryId(slug),
    });
  }

  if (entryId.startsWith('community:')) {
    const slug = entryId.slice('community:'.length);
    return readMarkdownRepairTarget(kb.communityPath(slug), {
      kind: 'community',
      slug,
      entryId: communityEntryId(slug),
    });
  }

  if (entryId.startsWith('principle:')) {
    const slug = entryId.slice('principle:'.length);
    return readMarkdownRepairTarget(kb.principlePath(slug), {
      kind: 'principle',
      slug,
      entryId: `principle:${slug}`,
    });
  }

  return null;
}

function readMarkdownRepairTarget<T extends Omit<MarkdownRepairTarget, 'path' | 'content'>>(
  path: string,
  target: T,
): (T & Pick<MarkdownRepairTarget, 'path' | 'content'>) | null {
  try {
    return {
      ...target,
      path,
      content: readFileSync(path, 'utf-8'),
    };
  } catch {
    return null;
  }
}

function collectActiveCorpusEntryIds(kb: Pick<KbRuntime, 'notesDir' | 'sourcesDir' | 'communitiesDir'>): ReadonlySet<KbEntryId> {
  const activeEntryIds = new Set<KbEntryId>();

  for (const filename of sortedMarkdownEntries(kb.notesDir())) {
    const parsed = parseKbEntryId(noteEntryId(stripMdExt(filename)));
    if (parsed !== null) {
      activeEntryIds.add(parsed);
    }
  }

  for (const filename of sortedMarkdownEntries(kb.sourcesDir())) {
    const parsed = parseKbEntryId(sourceEntryId(stripMdExt(filename)));
    if (parsed !== null) {
      activeEntryIds.add(parsed);
    }
  }

  for (const filename of sortedMarkdownEntries(kb.communitiesDir())) {
    const parsed = parseKbEntryId(communityEntryId(stripMdExt(filename)));
    if (parsed !== null) {
      activeEntryIds.add(parsed);
    }
  }

  return activeEntryIds;
}

function readLenientEntrySeq(content: string | null): number | null {
  if (content === null) {
    return null;
  }

  const match = extractLenientFrontmatterRegion(content).match(LENIENT_ENTRYSEQ_PATTERN);
  if (match === null) {
    return null;
  }

  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractLenientFrontmatterRegion(content: string): string {
  const match = content.match(LENIENT_FRONTMATTER_PATTERN);
  if (match !== null) {
    return match[1];
  }

  if (!content.startsWith('---')) {
    return content.slice(0, 2048);
  }

  return content.slice(4, 2048);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
