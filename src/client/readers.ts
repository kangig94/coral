import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { isNoEntryError } from '../shared/utils.js';
import {
  discussSourcesPath,
  JOBS_DIR,
  discussBaseDirForSource,
  discussDiscoveryPathForSource,
  discussEventLogPath,
  discussStatePath,
  discussSummaryIndexPathForSource,
  resolveProjectSource,
} from '../infra/paths.js';
import {
  isValidSessionEntry as isSharedValidSessionEntry,
  readSessionEntry as readSharedSessionEntry,
  readSessionEntryLenient as readSharedSessionEntryLenient,
  type LenientSessionEntry,
} from '../shared/session-entry.js';
import type { PersistedProgressRecord, PersistedStatusRecord, SessionEntry } from '../shared/types.js';
import type { DiscussState } from '../discuss/types.js';
import {
  discussStatuses,
  participationTypes,
  speakerTypes,
  transcriptResolveTypes,
  sessionEventKinds,
  resolveReasons,
} from '../discuss/types.js';
import {
  type DiscussDomainEvent,
  type PersistedDiscussSnapshot,
  controlPhases,
} from '../discuss/events.js';

const finiteNumberSchema = z.number().finite();
const integerSchema = z.number().int();
const nonNegativeIntegerSchema = integerSchema.min(0);
const positiveIntegerSchema = integerSchema.min(1);
const stringArraySchema = z.array(z.string());
const discussStatusSchema = z.enum(discussStatuses);
const participationSchema = z.enum(participationTypes);
const speakerTypeSchema = z.enum(speakerTypes);
const transcriptResolveTypeSchema = z.enum(transcriptResolveTypes);
const transcriptEventSchema = z.enum(sessionEventKinds);
const controlPhaseSchema = z.enum(controlPhases);
const resolveReasonSchema = z.enum(resolveReasons);

export type { LenientSessionEntry, ProvenanceState } from '../shared/session-entry.js';

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

function parseJsonLines<T>(text: string, parseLine: (value: unknown) => T | null): T[] {
  const entries: T[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim().length === 0) continue;
    try {
      const value = parseLine(JSON.parse(rawLine));
      if (value !== null) entries.push(value);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return entries;
}

/** Structural schema for persisted status records — validates fields callers branch on. */
const persistedStatusRecordSchema = z.object({
  jobId: z.string(),
  sessionId: z.string(),
  provider: z.string(),
  projectRoot: z.string(),
  backendNamespace: z.string(),
  phase: z.string(),
  launch: z.object({ state: z.string(), updatedAt: z.string() }).passthrough(),
}).passthrough();

/** Structural schema for persisted progress records. */
const persistedProgressRecordSchema = z.object({
  jobId: z.string(),
  sessionId: z.string(),
  eventId: z.number(),
  type: z.string(),
  ts: z.string(),
}).passthrough();

function readDirectoryEntries(baseDir: string): Array<{ name: string; isDirectory(): boolean }> {
  try {
    return readdirSync(baseDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

function recordLikeSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.union([z.record(z.string(), valueSchema), z.array(valueSchema)]);
}

function parseStringArray(value: unknown): string[] | null {
  const parsed = stringArraySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const unknownRecordLikeSchema = recordLikeSchema(z.unknown());
const stringRecordLikeSchema = recordLikeSchema(z.string());
const booleanRecordLikeSchema = recordLikeSchema(z.boolean());
const numberRecordLikeSchema = recordLikeSchema(finiteNumberSchema);
const nullableNumberRecordLikeSchema = recordLikeSchema(z.union([finiteNumberSchema, z.null()]));

const discussAgentStateSchema = z
  .object({
    persona: z.string(),
    display_name: z.string(),
    participation: participationSchema,
    quota_remaining: finiteNumberSchema,
    total_speaks: finiteNumberSchema,
    fallback_used: z.boolean(),
    banned: z.boolean(),
  })
  .passthrough();

const transcriptEntrySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bids'),
      step: finiteNumberSchema,
      epoch: finiteNumberSchema,
      ts: z.string(),
      bids: numberRecordLikeSchema,
      effective_bids: numberRecordLikeSchema.optional(),
      thoughts: stringRecordLikeSchema.optional(),
      winner: z.union([z.string(), z.null()]),
      resolve_type: transcriptResolveTypeSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('speech'),
      step: finiteNumberSchema,
      epoch: finiteNumberSchema,
      ts: z.string(),
      agent: z.string(),
      display_name: z.string(),
      content: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('follow_up'),
      epoch: finiteNumberSchema,
      ts: z.string(),
      agent: z.string(),
      question: z.string(),
      answer: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('epoch_summary'),
      epoch: finiteNumberSchema,
      ts: z.string(),
      summary: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('session_event'),
      epoch: finiteNumberSchema,
      ts: z.string(),
      event: transcriptEventSchema,
      detail: z.string(),
    })
    .passthrough(),
]);

export function isValidSessionEntry(value: unknown): value is SessionEntry {
  return isSharedValidSessionEntry(value);
}

const discussStateSchema = z
  .object({
    session_id: z.string(),
    topic: z.string(),
    status: z.string(),
    agents: unknownRecordLikeSchema,
  })
  .passthrough();

const sessionCreatedInputSchema = z
  .object({
    topic: z.string(),
    min_bid_delay_ms: finiteNumberSchema,
    agents: z.array(
      z
        .object({
          name: z.string(),
          persona: z.string(),
          participation: participationSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();

const sessionCreatedConfigSchema = z
  .object({
    bidThreshold: finiteNumberSchema,
    maxEpochs: finiteNumberSchema,
    quotaPerEpoch: finiteNumberSchema,
  })
  .passthrough();

const sessionCreatedAgentExecutionSchema = z.union([
  z
    .object({
      manual: z.literal(true),
      provider: z.undefined().optional(),
      model: z.undefined().optional(),
    })
    .passthrough(),
  z
    .object({
      manual: z.literal(false),
      provider: z.string(),
      model: z.string(),
    })
    .passthrough(),
]);

const followUpQueueItemSchema = z
  .object({
    agent: z.string(),
    question: z.string(),
  })
  .passthrough();

const bidRoundClosedOutcomeSchema = z.union([
  z
    .object({
      winner: z.string(),
      speaker_type: speakerTypeSchema,
    })
    .passthrough(),
  z
    .object({
      no_winner: z.literal(true),
      reason: resolveReasonSchema,
    })
    .passthrough(),
]);

const bidRoundClosedStateMutationsSchema = z
  .object({
    cold_start: z.boolean().optional(),
    fallback_used: booleanRecordLikeSchema.optional(),
    quota_remaining: numberRecordLikeSchema.optional(),
    epoch: finiteNumberSchema.optional(),
  })
  .passthrough();

function createDiscussEventSchema<K extends DiscussDomainEvent['kind']>(kind: K, payloadSchema: z.ZodTypeAny) {
  return z
    .object({
      v: z.literal(1),
      sessionId: z.string(),
      projectRoot: z.string(),
      topic: z.string(),
      seq: positiveIntegerSchema,
      kind: z.literal(kind),
      ts: z.string(),
      payload: payloadSchema,
    })
    .passthrough();
}

const discussDomainEventSchema = z.discriminatedUnion('kind', [
  createDiscussEventSchema(
    'session.created',
    z
      .object({
        input: sessionCreatedInputSchema,
        config: sessionCreatedConfigSchema,
        agentExecution: recordLikeSchema(sessionCreatedAgentExecutionSchema),
      })
      .passthrough(),
  ),
  createDiscussEventSchema('bidding.opened', unknownRecordLikeSchema),
  createDiscussEventSchema(
    'bid.submitted',
    z
      .object({
        agent: z.string(),
        score: finiteNumberSchema,
        thought: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'participants.expelled',
    z
      .object({
        agents: stringArraySchema,
        isRespawn: z.boolean(),
        hint: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'bid.round.closed',
    z
      .object({
        allBids: numberRecordLikeSchema,
        effectiveBids: numberRecordLikeSchema,
        thoughts: stringRecordLikeSchema,
        outcome: bidRoundClosedOutcomeSchema,
        stateMutations: bidRoundClosedStateMutationsSchema,
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'speech.recorded',
    z
      .object({
        agent: z.string(),
        content: z.string(),
        decrementQuota: z.boolean(),
        recordLastSpeechStep: integerSchema.optional(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'speech.timed_out',
    z
      .object({
        agent: z.string(),
        content: z.string(),
        decrementQuota: z.boolean(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'epoch.summary.recorded',
    z
      .object({
        summary: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'must_answer.carry_forward.set',
    z
      .object({
        items: stringArraySchema,
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'follow_up.queue.set',
    z
      .object({
        queue: z.array(followUpQueueItemSchema),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'follow_up.answered',
    z
      .object({
        agent: z.string(),
        question: z.string(),
        answer: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'session.ended',
    z
      .object({
        endReason: z.string().optional(),
        endReasonContent: z.union([z.string(), z.null()]).optional(),
        force: z.boolean().optional(),
        reason: z.string().optional(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'session.synthesized',
    z
      .object({
        synthesis: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'agent.run.bound',
    z
      .object({
        agent: z.string(),
        executionSessionId: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'agent.job.started',
    z
      .object({
        agent: z.string(),
        jobId: z.string(),
        purpose: z.string(),
        attempt: integerSchema,
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'agent.job.finished',
    z
      .object({
        agent: z.string(),
        jobId: z.string(),
        outcome: z.string(),
        attempt: integerSchema,
      })
      .passthrough(),
  ),
]);

const persistedDiscussAgentRunSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    executionSessionId: z.string().optional(),
    currentJobId: z.string().optional(),
    currentJobPurpose: z.string().optional(),
    currentAttempt: integerSchema.optional(),
    lastAttemptOutcome: z.string().optional(),
  })
  .passthrough();

const persistedDiscussRuntimeSchema = z
  .object({
    controlPhase: controlPhaseSchema,
    carryForwardMustAnswer: stringArraySchema,
    followUpQueue: z.array(followUpQueueItemSchema),
    agentRuns: recordLikeSchema(persistedDiscussAgentRunSchema),
  })
  .passthrough();

const persistedDiscussStateSchema = z
  .object({
    session_id: z.string(),
    topic: z.string(),
    status: discussStatusSchema,
    step: integerSchema,
    epoch: integerSchema,
    max_epochs: integerSchema,
    quota_per_epoch: finiteNumberSchema,
    cold_start: z.boolean(),
    agents: recordLikeSchema(discussAgentStateSchema),
    current_bids: nullableNumberRecordLikeSchema,
    current_thoughts: stringRecordLikeSchema,
    pending_bidders: stringArraySchema,
    current_speaker: z.union([z.string(), z.null()]),
    speaker_type: z.union([speakerTypeSchema, z.null()]),
    epoch_summary_written: z.union([integerSchema, z.null()]),
    created_at: z.string(),
    last_activity_at: z.string(),
    last_speech_step: integerSchema,
    pending_since_ts: z.union([finiteNumberSchema, z.null()]),
    bid_release_step: integerSchema,
    end_reason_content: z.union([z.string(), z.null()]),
    transcript: z.array(transcriptEntrySchema),
    bid_threshold: finiteNumberSchema,
    min_bid_delay_ms: finiteNumberSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const agentNames = new Set(Object.keys(value.agents));

    for (const name of Object.keys(value.current_bids)) {
      if (!agentNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'current_bids keys must match agents',
          path: ['current_bids', name],
        });
      }
    }

    for (const name of Object.keys(value.current_thoughts)) {
      if (!agentNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'current_thoughts keys must match agents',
          path: ['current_thoughts', name],
        });
      }
    }

    for (const name of value.pending_bidders) {
      if (!agentNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pending_bidders entries must match agents',
          path: ['pending_bidders'],
        });
      }
    }

    if (value.current_speaker !== null && !agentNames.has(value.current_speaker)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'current_speaker must match agents',
        path: ['current_speaker'],
      });
    }

    if (value.status === 'speaking' && (value.current_speaker === null || value.speaker_type === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'speaking state requires current_speaker and speaker_type',
        path: ['status'],
      });
    }
  });

const persistedDiscussSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    sessionId: z.string(),
    projectRoot: z.string(),
    updatedAt: z.string(),
    lastAppliedSeq: nonNegativeIntegerSchema,
    logByteOffset: nonNegativeIntegerSchema.optional(),
    state: persistedDiscussStateSchema,
    runtime: persistedDiscussRuntimeSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.state.session_id !== value.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'snapshot sessionId must match state.session_id',
        path: ['state', 'session_id'],
      });
    }

    for (const name of Object.keys(value.runtime.agentRuns)) {
      if (!(name in value.state.agents)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'runtime.agentRuns keys must be compatible with state.agents',
          path: ['runtime', 'agentRuns', name],
        });
      }
    }
  });

const discussDiscoverySessionSchema = z
  .object({
    sessionId: z.string(),
    topic: z.string(),
    sessionDir: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

const discussSummaryIndexRowSchema = z
  .object({
    sessionId: z.string(),
    projectRoot: z.string(),
    topic: z.string(),
    status: discussStatusSchema,
    createdAt: z.string(),
    agentCount: nonNegativeIntegerSchema,
    updatedAt: z.string(),
    lastSeq: nonNegativeIntegerSchema,
  })
  .passthrough();

function isValidDiscussState(value: unknown): value is DiscussState {
  return discussStateSchema.safeParse(value).success;
}

function isValidDiscussDomainEvent(value: unknown): value is DiscussDomainEvent {
  return discussDomainEventSchema.safeParse(value).success;
}

function isValidPersistedDiscussSnapshot(value: unknown): value is PersistedDiscussSnapshot {
  return persistedDiscussSnapshotSchema.safeParse(value).success;
}

type DiscussSourcesRegistryData = {
  updatedAt?: string;
  sources: string[];
};

function parseSourceEnvelopeData<T>(
  value: unknown,
  source: string,
  rowSchema: z.ZodType<T>,
  label: string,
): { source: string; updatedAt: string; sessions: T[] } | null {
  const parsed = z
    .object({
      updatedAt: z.string(),
      sessions: z.array(rowSchema),
      source: z.unknown().optional(),
      projectRoot: z.unknown().optional(),
    })
    .passthrough()
    .superRefine((envelope, ctx) => {
      const fileSource =
        typeof envelope.source === 'string'
          ? envelope.source
          : typeof envelope.projectRoot === 'string'
            ? source
            : null;

      if (fileSource !== source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} source does not match requested source`,
          path: ['source'],
        });
      }
    })
    .transform((envelope) => ({
      source,
      updatedAt: envelope.updatedAt,
      sessions: envelope.sessions,
    }))
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseDiscussDiscoveryData(value: unknown, source: string): DiscussDiscoveryData | null {
  return parseSourceEnvelopeData(value, source, discussDiscoverySessionSchema, 'discovery');
}

function parseDiscussSummaryIndexData(value: unknown, source: string): DiscussSummaryIndexData | null {
  return parseSourceEnvelopeData(value, source, discussSummaryIndexRowSchema, 'summary index');
}

function parseDiscussSourcesRegistry(value: unknown): DiscussSourcesRegistryData | null {
  const parsed = z
    .object({
      updatedAt: z.unknown().optional(),
      sources: z.unknown().optional(),
      projectRoots: z.unknown().optional(),
    })
    .passthrough()
    .superRefine((registry, ctx) => {
      if (registry.updatedAt !== undefined && typeof registry.updatedAt !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'updatedAt must be a string when present',
          path: ['updatedAt'],
        });
      }

      if (parseStringArray(registry.sources) !== null) {
        return;
      }

      if (parseStringArray(registry.projectRoots) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'registry must provide sources or projectRoots',
          path: ['sources'],
        });
      }
    })
    .transform((registry): DiscussSourcesRegistryData => {
      const sources = parseStringArray(registry.sources);
      if (sources !== null) {
        return {
          updatedAt: typeof registry.updatedAt === 'string' ? registry.updatedAt : undefined,
          sources: [...new Set(sources)],
        };
      }

      const projectRoots = parseStringArray(registry.projectRoots) ?? [];
      return {
        updatedAt: typeof registry.updatedAt === 'string' ? registry.updatedAt : undefined,
        sources: [...new Set(projectRoots.map((projectRoot) => resolveProjectSource(projectRoot)))],
      };
    })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Persisted discuss event log entry.
 */
export type DiscussEventLogEntry = DiscussDomainEvent;

/**
 * Session reference stored in discuss discovery metadata.
 */
export interface DiscussDiscoverySession {
  sessionId: string;
  topic: string;
  sessionDir: string;
  createdAt: string;
}

/**
 * Discovery metadata for all discuss sessions under a project root.
 */
export interface DiscussDiscoveryData {
  sessions: DiscussDiscoverySession[];
  source: string;
  updatedAt: string;
}

/**
 * Persisted summary row used for index-only discuss listing.
 */
export interface DiscussSummaryIndexRow {
  sessionId: string;
  projectRoot: string;
  topic: string;
  status: DiscussState['status'];
  createdAt: string;
  agentCount: number;
  updatedAt: string;
  lastSeq: number;
}

/**
 * Summary index metadata for all discuss sessions under a project root.
 */
export interface DiscussSummaryIndexData {
  sessions: DiscussSummaryIndexRow[];
  source: string;
  updatedAt: string;
}

/**
 * Reads and parses a persisted job status record.
 */
export function readStatusRecord(jobId: string): PersistedStatusRecord | null {
  const record = readJsonFile(join(JOBS_DIR, jobId, 'status.json'));
  if (record === null) return null;
  const parsed = persistedStatusRecordSchema.safeParse(record);
  return parsed.success ? (parsed.data as PersistedStatusRecord) : null;
}

/**
 * Reads and parses all persisted progress records for a job.
 */
export function readProgressLog(jobId: string): PersistedProgressRecord[] {
  const log = readTextFile(join(JOBS_DIR, jobId, 'progress.jsonl'));
  if (log === null) return [];
  return parseJsonLines(log, (lineValue) => {
    const parsed = persistedProgressRecordSchema.safeParse(lineValue);
    return parsed.success ? (parsed.data as PersistedProgressRecord) : null;
  });
}

/**
 * Reads and validates a strict execution session entry JSON file.
 */
export function readSessionEntry(sessionPath: string): SessionEntry | null {
  return readSharedSessionEntry(sessionPath);
}

/**
 * Reads a session entry for reporting surfaces that must tolerate legacy or partial files.
 */
export function readSessionEntryLenient(sessionPath: string): LenientSessionEntry | null {
  return readSharedSessionEntryLenient(sessionPath);
}

/**
 * Reads and minimally validates a persisted discuss state file.
 */
export function readDiscussState(statePath: string): DiscussState | null {
  const state = readJsonFile(statePath);
  if (state === null) return null;
  return isValidDiscussState(state) ? state : null;
}

/**
 * Reads and validates a v2 persisted discuss snapshot.
 */
export function readDiscussSnapshot(statePath: string): PersistedDiscussSnapshot | null {
  const snapshot = readJsonFile(statePath);
  if (snapshot === null) return null;
  return isValidPersistedDiscussSnapshot(snapshot) ? snapshot : null;
}

/**
 * Reads and parses a discuss JSONL event log, skipping malformed lines.
 */
export function readDiscussEventLog(logPath: string): DiscussDomainEvent[] {
  const log = readTextFile(logPath);
  if (log === null) return [];
  return parseJsonLines(log, (lineValue) => (isValidDiscussDomainEvent(lineValue) ? lineValue : null));
}

/**
 * Reads and validates the discuss discovery metadata for a project.
 */
export function readDiscussDiscoveryForSource(source: string): DiscussDiscoveryData | null {
  const discovery = readJsonFile(discussDiscoveryPathForSource(source));
  if (discovery === null) return null;
  return parseDiscussDiscoveryData(discovery, source);
}

/**
 * Reads and validates the discuss discovery metadata for a project.
 */
export function readDiscussDiscovery(projectRoot: string): DiscussDiscoveryData | null {
  return readDiscussDiscoveryForSource(resolveProjectSource(projectRoot));
}

/**
 * Reads and validates the discuss summary index for a project.
 */
export function readDiscussSummaryIndexForSource(source: string): DiscussSummaryIndexData | null {
  const index = readJsonFile(discussSummaryIndexPathForSource(source));
  if (index === null) return null;
  return parseDiscussSummaryIndexData(index, source);
}

/**
 * Reads and validates the discuss summary index for a project.
 */
export function readDiscussSummaryIndex(projectRoot: string): DiscussSummaryIndexData | null {
  return readDiscussSummaryIndexForSource(resolveProjectSource(projectRoot));
}

export function readDiscussSources(): string[] {
  return parseDiscussSourcesRegistry(readJsonFile(discussSourcesPath()))?.sources ?? [];
}

export function readDiscussProjectRoots(): string[] {
  return readDiscussSources();
}

function canUseDiscussSessionDir(sessionDir: string): boolean {
  return existsSync(discussStatePath(sessionDir)) || existsSync(discussEventLogPath(sessionDir));
}

function scanPersistedDiscussSessionsForSource(source: string): DiscussDiscoverySession[] {
  const baseDir = discussBaseDirForSource(source);
  const entries = readDirectoryEntries(baseDir);

  const sessions: DiscussDiscoverySession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(baseDir, entry.name);
    const snapshot = readDiscussSnapshot(discussStatePath(sessionDir));
    if (!snapshot) continue;
    sessions.push({
      sessionId: snapshot.sessionId,
      topic: snapshot.state.topic,
      sessionDir,
      createdAt: snapshot.state.created_at,
    });
  }

  return sessions;
}

/**
 * Resolves a discuss session directory using discovery first, then directory scan fallback.
 */
export function resolveDiscussSessionDirForSource(source: string, sessionId: string): string | null {
  const discovery = readDiscussDiscoveryForSource(source);
  const discoveredDir = discovery?.sessions.find((session) => session.sessionId === sessionId)?.sessionDir;
  if (discoveredDir && canUseDiscussSessionDir(discoveredDir)) {
    return discoveredDir;
  }

  const baseDir = discussBaseDirForSource(source);
  const entries = readDirectoryEntries(baseDir);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(baseDir, entry.name);
    if (entry.name === sessionId && canUseDiscussSessionDir(sessionDir)) {
      return sessionDir;
    }
    const snapshot = readDiscussSnapshot(discussStatePath(sessionDir));
    if (snapshot?.sessionId === sessionId) {
      return sessionDir;
    }
  }

  return null;
}

/**
 * Resolves a discuss session directory using discovery first, then directory scan fallback.
 */
export function resolveDiscussSessionDir(projectRoot: string, sessionId: string): string | null {
  return resolveDiscussSessionDirForSource(resolveProjectSource(projectRoot), sessionId);
}

/**
 * Lists persisted discuss sessions using discovery first with state-based fallback repair.
 */
export function listPersistedDiscussSessionsForSource(source: string): DiscussDiscoverySession[] {
  const discovered = readDiscussDiscoveryForSource(source);
  const scanned = scanPersistedDiscussSessionsForSource(source);
  if (!discovered) {
    return scanned;
  }

  const usableDiscovered: DiscussDiscoverySession[] = [];
  let stale = false;
  for (const session of discovered.sessions) {
    if (!canUseDiscussSessionDir(session.sessionDir)) {
      stale = true;
      continue;
    }
    usableDiscovered.push(session);
  }

  const discoveredIds = new Set(usableDiscovered.map((session) => session.sessionId));
  if (scanned.some((session) => !discoveredIds.has(session.sessionId))) {
    stale = true;
  }

  if (!stale) {
    return usableDiscovered;
  }

  const merged = new Map<string, DiscussDiscoverySession>();
  for (const session of usableDiscovered) {
    merged.set(session.sessionId, session);
  }
  for (const session of scanned) {
    if (!merged.has(session.sessionId)) {
      merged.set(session.sessionId, session);
    }
  }
  return [...merged.values()];
}

/**
 * Lists persisted discuss sessions using discovery first with state-based fallback repair.
 */
export function listPersistedDiscussSessions(projectRoot: string): DiscussDiscoverySession[] {
  return listPersistedDiscussSessionsForSource(resolveProjectSource(projectRoot));
}
