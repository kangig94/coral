import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, isStringArray } from '../shared/mcp-utils.js';
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
import type { PersistedProgressRecord, PersistedStatusRecord } from '../shared/types.js';
import type { SessionEntry } from '../execution/session-manager.js';
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
  discussEventKinds,
} from '../discuss/events.js';
import { isNoEntryError } from '../shared/mcp-utils.js';

const discussEventKindSet = new Set<string>(discussEventKinds);
const discussStatusSet = new Set<string>(discussStatuses);
const participationSet = new Set<string>(participationTypes);
const speakerTypeSet = new Set<string>(speakerTypes);
const transcriptResolveTypeSet = new Set<string>(transcriptResolveTypes);
const transcriptEventSet = new Set<string>(sessionEventKinds);
const controlPhaseSet = new Set<string>(controlPhases);
const resolveReasonSet = new Set<string>(resolveReasons);

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

function readDirectoryEntries(baseDir: string): Array<{ name: string; isDirectory(): boolean }> {
  try {
    return readdirSync(baseDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isRecordOf(value: unknown, predicate: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(predicate);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecordOf(value, (entry) => typeof entry === 'string');
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecordOf(value, (entry) => typeof entry === 'boolean');
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecordOf(value, isFiniteNumber);
}

function isNullableNumberRecord(value: unknown): value is Record<string, number | null> {
  return isRecordOf(value, (entry) => entry === null || isFiniteNumber(entry));
}

function isValidDiscussAgentState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.persona === 'string' &&
    typeof value.display_name === 'string' &&
    typeof value.participation === 'string' &&
    participationSet.has(value.participation) &&
    isFiniteNumber(value.quota_remaining) &&
    isFiniteNumber(value.total_speaks) &&
    typeof value.fallback_used === 'boolean' &&
    typeof value.banned === 'boolean'
  );
}

function isValidTranscriptEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'bids':
      return (
        isFiniteNumber(value.step) &&
        isFiniteNumber(value.epoch) &&
        typeof value.ts === 'string' &&
        isNumberRecord(value.bids) &&
        (value.effective_bids === undefined || isNumberRecord(value.effective_bids)) &&
        (value.thoughts === undefined || isStringRecord(value.thoughts)) &&
        (value.winner === null || typeof value.winner === 'string') &&
        typeof value.resolve_type === 'string' &&
        transcriptResolveTypeSet.has(value.resolve_type)
      );

    case 'speech':
      return (
        isFiniteNumber(value.step) &&
        isFiniteNumber(value.epoch) &&
        typeof value.ts === 'string' &&
        typeof value.agent === 'string' &&
        typeof value.display_name === 'string' &&
        typeof value.content === 'string'
      );

    case 'follow_up':
      return (
        isFiniteNumber(value.epoch) &&
        typeof value.ts === 'string' &&
        typeof value.agent === 'string' &&
        typeof value.question === 'string' &&
        typeof value.answer === 'string'
      );

    case 'epoch_summary':
      return isFiniteNumber(value.epoch) && typeof value.ts === 'string' && typeof value.summary === 'string';

    case 'session_event':
      return (
        isFiniteNumber(value.epoch) &&
        typeof value.ts === 'string' &&
        typeof value.event === 'string' &&
        transcriptEventSet.has(value.event) &&
        typeof value.detail === 'string'
      );

    default:
      return false;
  }
}

export function isValidSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    typeof v.provider === 'string' &&
    typeof v.name === 'string' &&
    typeof v.state === 'string' &&
    (v.state === 'pending' || v.state === 'ready' || v.state === 'non_resumable') &&
    typeof v.model === 'string' &&
    typeof v.cwd === 'string' &&
    typeof v.version === 'number'
  );
}

function isValidDiscussState(value: unknown): value is DiscussState {
  if (!isRecord(value)) return false;
  return (
    typeof value.session_id === 'string' &&
    typeof value.topic === 'string' &&
    typeof value.status === 'string' &&
    isRecord(value.agents)
  );
}

function isValidSessionCreatedInput(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.agents)) return false;
  return (
    typeof value.topic === 'string' &&
    isFiniteNumber(value.min_bid_delay_ms) &&
    value.agents.every(
      (agent) =>
        isRecord(agent) &&
        typeof agent.name === 'string' &&
        typeof agent.persona === 'string' &&
        typeof agent.participation === 'string' &&
        participationSet.has(agent.participation),
    )
  );
}

function isValidSessionCreatedConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.bidThreshold) && isFiniteNumber(value.maxEpochs) && isFiniteNumber(value.quotaPerEpoch);
}

function isValidSessionCreatedAgentExecution(value: unknown): boolean {
  if (!isRecord(value) || typeof value.manual !== 'boolean') return false;
  if (value.manual) {
    return value.provider === undefined && value.model === undefined;
  }
  return typeof value.provider === 'string' && typeof value.model === 'string';
}

function isValidFollowUpQueueItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.agent === 'string' && typeof value.question === 'string';
}

function isValidBidRoundClosedOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.winner === 'string') {
    return typeof value.speaker_type === 'string' && speakerTypeSet.has(value.speaker_type);
  }
  return value.no_winner === true && typeof value.reason === 'string' && resolveReasonSet.has(value.reason);
}

function isValidBidRoundClosedStateMutations(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.cold_start === undefined || typeof value.cold_start === 'boolean') &&
    (value.fallback_used === undefined || isBooleanRecord(value.fallback_used)) &&
    (value.quota_remaining === undefined || isNumberRecord(value.quota_remaining)) &&
    (value.epoch === undefined || isFiniteNumber(value.epoch))
  );
}

function isValidDiscussEventPayload(kind: DiscussDomainEvent['kind'], payload: unknown): boolean {
  if (!isRecord(payload)) return false;

  switch (kind) {
    case 'session.created':
      return (
        isValidSessionCreatedInput(payload.input) &&
        isValidSessionCreatedConfig(payload.config) &&
        isRecord(payload.agentExecution) &&
        Object.values(payload.agentExecution).every(isValidSessionCreatedAgentExecution)
      );

    case 'bidding.opened':
      return true;

    case 'bid.submitted':
      return typeof payload.agent === 'string' && isFiniteNumber(payload.score) && typeof payload.thought === 'string';

    case 'participants.expelled':
      return (
        isStringArray(payload.agents) && typeof payload.isRespawn === 'boolean' && typeof payload.hint === 'string'
      );

    case 'bid.round.closed':
      return (
        isNumberRecord(payload.allBids) &&
        isNumberRecord(payload.effectiveBids) &&
        isStringRecord(payload.thoughts) &&
        isValidBidRoundClosedOutcome(payload.outcome) &&
        isValidBidRoundClosedStateMutations(payload.stateMutations)
      );

    case 'speech.recorded':
      return (
        typeof payload.agent === 'string' &&
        typeof payload.content === 'string' &&
        typeof payload.decrementQuota === 'boolean' &&
        (payload.recordLastSpeechStep === undefined || isInteger(payload.recordLastSpeechStep))
      );

    case 'speech.timed_out':
      return (
        typeof payload.agent === 'string' &&
        typeof payload.content === 'string' &&
        typeof payload.decrementQuota === 'boolean'
      );

    case 'epoch.summary.recorded':
      return typeof payload.summary === 'string';

    case 'must_answer.carry_forward.set':
      return isStringArray(payload.items);

    case 'follow_up.queue.set':
      return Array.isArray(payload.queue) && payload.queue.every(isValidFollowUpQueueItem);

    case 'follow_up.answered':
      return (
        typeof payload.agent === 'string' && typeof payload.question === 'string' && typeof payload.answer === 'string'
      );

    case 'session.ended':
      return (
        (payload.endReason === undefined || typeof payload.endReason === 'string') &&
        (payload.endReasonContent === undefined ||
          payload.endReasonContent === null ||
          typeof payload.endReasonContent === 'string') &&
        (payload.force === undefined || typeof payload.force === 'boolean') &&
        (payload.reason === undefined || typeof payload.reason === 'string')
      );

    case 'session.synthesized':
      return typeof payload.synthesis === 'string';

    case 'agent.run.bound':
      return typeof payload.agent === 'string' && typeof payload.executionSessionId === 'string';

    case 'agent.job.started':
      return (
        typeof payload.agent === 'string' &&
        typeof payload.jobId === 'string' &&
        typeof payload.purpose === 'string' &&
        isInteger(payload.attempt)
      );

    case 'agent.job.finished':
      return (
        typeof payload.agent === 'string' &&
        typeof payload.jobId === 'string' &&
        typeof payload.outcome === 'string' &&
        isInteger(payload.attempt)
      );
  }
}

function isValidDiscussDomainEvent(value: unknown): value is DiscussDomainEvent {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    typeof value.sessionId === 'string' &&
    typeof value.projectRoot === 'string' &&
    typeof value.topic === 'string' &&
    isInteger(value.seq) &&
    value.seq > 0 &&
    typeof value.kind === 'string' &&
    discussEventKindSet.has(value.kind) &&
    typeof value.ts === 'string' &&
    isValidDiscussEventPayload(value.kind as DiscussDomainEvent['kind'], value.payload)
  );
}

function isValidPersistedDiscussRuntime(value: unknown): value is PersistedDiscussSnapshot['runtime'] {
  if (!isRecord(value)) return false;
  return (
    typeof value.controlPhase === 'string' &&
    controlPhaseSet.has(value.controlPhase) &&
    isStringArray(value.carryForwardMustAnswer) &&
    Array.isArray(value.followUpQueue) &&
    value.followUpQueue.every(isValidFollowUpQueueItem) &&
    isRecord(value.agentRuns) &&
    Object.values(value.agentRuns).every(
      (run) =>
        isRecord(run) &&
        typeof run.provider === 'string' &&
        typeof run.model === 'string' &&
        (run.executionSessionId === undefined || typeof run.executionSessionId === 'string') &&
        (run.currentJobId === undefined || typeof run.currentJobId === 'string') &&
        (run.currentJobPurpose === undefined || typeof run.currentJobPurpose === 'string') &&
        (run.currentAttempt === undefined || isInteger(run.currentAttempt)) &&
        (run.lastAttemptOutcome === undefined || typeof run.lastAttemptOutcome === 'string'),
    )
  );
}

function isValidPersistedDiscussState(value: unknown): value is DiscussState {
  if (!isRecord(value) || !isRecord(value.agents)) return false;

  const agentNames = new Set(Object.keys(value.agents));
  const currentSpeaker = value.current_speaker;
  const speakerType = value.speaker_type;

  return (
    typeof value.session_id === 'string' &&
    typeof value.topic === 'string' &&
    typeof value.status === 'string' &&
    discussStatusSet.has(value.status) &&
    isInteger(value.step) &&
    isInteger(value.epoch) &&
    isInteger(value.max_epochs) &&
    isFiniteNumber(value.quota_per_epoch) &&
    typeof value.cold_start === 'boolean' &&
    Object.values(value.agents).every(isValidDiscussAgentState) &&
    isNullableNumberRecord(value.current_bids) &&
    Object.keys(value.current_bids).every((name) => agentNames.has(name)) &&
    isStringRecord(value.current_thoughts) &&
    Object.keys(value.current_thoughts).every((name) => agentNames.has(name)) &&
    isStringArray(value.pending_bidders) &&
    value.pending_bidders.every((name) => agentNames.has(name)) &&
    (currentSpeaker === null || (typeof currentSpeaker === 'string' && agentNames.has(currentSpeaker))) &&
    (speakerType === null || (typeof speakerType === 'string' && speakerTypeSet.has(speakerType))) &&
    (value.epoch_summary_written === null || isInteger(value.epoch_summary_written)) &&
    typeof value.created_at === 'string' &&
    typeof value.last_activity_at === 'string' &&
    isInteger(value.last_speech_step) &&
    (value.pending_since_ts === null || isFiniteNumber(value.pending_since_ts)) &&
    isInteger(value.bid_release_step) &&
    (value.end_reason_content === null || typeof value.end_reason_content === 'string') &&
    Array.isArray(value.transcript) &&
    value.transcript.every(isValidTranscriptEntry) &&
    isFiniteNumber(value.bid_threshold) &&
    isFiniteNumber(value.min_bid_delay_ms) &&
    (value.status !== 'speaking' || (currentSpeaker !== null && speakerType !== null))
  );
}

function isValidPersistedDiscussSnapshot(value: unknown): value is PersistedDiscussSnapshot {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 2 ||
    typeof value.sessionId !== 'string' ||
    typeof value.projectRoot !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isInteger(value.lastAppliedSeq) ||
    value.lastAppliedSeq < 0 ||
    (value.logByteOffset !== undefined && (!isInteger(value.logByteOffset) || value.logByteOffset < 0))
  ) {
    return false;
  }

  const state = value.state;
  const runtime = value.runtime;
  if (!isValidPersistedDiscussState(state) || !isValidPersistedDiscussRuntime(runtime)) {
    return false;
  }

  return state.session_id === value.sessionId && Object.keys(runtime.agentRuns).every((name) => name in state.agents);
}

function isValidDiscussDiscoverySession(value: unknown): value is DiscussDiscoverySession {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === 'string' &&
    typeof value.topic === 'string' &&
    typeof value.sessionDir === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isValidDiscussSummaryIndexRow(value: unknown): value is DiscussSummaryIndexRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === 'string' &&
    typeof value.projectRoot === 'string' &&
    typeof value.topic === 'string' &&
    typeof value.status === 'string' &&
    discussStatusSet.has(value.status) &&
    typeof value.createdAt === 'string' &&
    isInteger(value.agentCount) &&
    value.agentCount >= 0 &&
    typeof value.updatedAt === 'string' &&
    isInteger(value.lastSeq) &&
    value.lastSeq >= 0
  );
}

type DiscussSourcesRegistryData = {
  updatedAt?: string;
  sources: string[];
};

function parseDiscussDiscoveryData(value: unknown, source: string): DiscussDiscoveryData | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null;

  const fileSource =
    typeof value.source === 'string' ? value.source : typeof value.projectRoot === 'string' ? source : null;

  if (
    fileSource !== source ||
    typeof value.updatedAt !== 'string' ||
    !value.sessions.every(isValidDiscussDiscoverySession)
  ) {
    return null;
  }

  return {
    source,
    updatedAt: value.updatedAt,
    sessions: value.sessions as DiscussDiscoverySession[],
  };
}

function parseDiscussSummaryIndexData(value: unknown, source: string): DiscussSummaryIndexData | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null;

  const fileSource =
    typeof value.source === 'string' ? value.source : typeof value.projectRoot === 'string' ? source : null;

  if (
    fileSource !== source ||
    typeof value.updatedAt !== 'string' ||
    !value.sessions.every(isValidDiscussSummaryIndexRow)
  ) {
    return null;
  }

  return {
    source,
    updatedAt: value.updatedAt,
    sessions: value.sessions as DiscussSummaryIndexRow[],
  };
}

function parseDiscussSourcesRegistry(value: unknown): DiscussSourcesRegistryData | null {
  if (!isRecord(value) || (value.updatedAt !== undefined && typeof value.updatedAt !== 'string')) {
    return null;
  }

  if (isStringArray(value.sources)) {
    return {
      updatedAt: value.updatedAt,
      sources: [...new Set(value.sources)],
    };
  }

  if (!isStringArray(value.projectRoots)) {
    return null;
  }

  return {
    updatedAt: value.updatedAt,
    sources: [...new Set(value.projectRoots.map((projectRoot) => resolveProjectSource(projectRoot)))],
  };
}

/**
 * Provenance marker for lenient session scans.
 */
export type ProvenanceState = 'authoritative' | 'legacy_unresolved';

/**
 * Backward-compatible session view for indexing and reporting surfaces.
 */
export interface LenientSessionEntry {
  sessionId: string;
  provider?: string;
  name?: string;
  state?: string;
  activeJobId?: string;
  lastJobId?: string;
  conversationRef?: string;
  model?: string;
  cwd?: string;
  projectRoot?: string;
  createdAt?: string;
  lastUsedAt?: string;
  version?: number;
  provenanceState: ProvenanceState;
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
  return record === null ? null : (record as PersistedStatusRecord);
}

/**
 * Reads and parses all persisted progress records for a job.
 */
export function readProgressLog(jobId: string): PersistedProgressRecord[] {
  const log = readTextFile(join(JOBS_DIR, jobId, 'progress.jsonl'));
  if (log === null) return [];
  return parseJsonLines(log, (lineValue) => lineValue as PersistedProgressRecord);
}

/**
 * Reads and validates a strict execution session entry JSON file.
 */
export function readSessionEntry(sessionPath: string): SessionEntry | null {
  const entry = readJsonFile(sessionPath);
  if (entry === null) return null;
  return isValidSessionEntry(entry) ? entry : null;
}

/**
 * Reads a session entry for reporting surfaces that must tolerate legacy or partial files.
 */
export function readSessionEntryLenient(sessionPath: string): LenientSessionEntry | null {
  const entry = readJsonFile(sessionPath);
  if (!isRecord(entry) || typeof entry.sessionId !== 'string') return null;

  const projectRoot = typeof entry.projectRoot === 'string' ? entry.projectRoot : undefined;
  const lenientEntry: LenientSessionEntry = {
    sessionId: entry.sessionId,
    provenanceState: projectRoot === undefined ? 'legacy_unresolved' : 'authoritative',
  };

  if (typeof entry.provider === 'string') lenientEntry.provider = entry.provider;
  if (typeof entry.name === 'string') lenientEntry.name = entry.name;
  if (typeof entry.state === 'string') lenientEntry.state = entry.state;
  if (typeof entry.activeJobId === 'string') lenientEntry.activeJobId = entry.activeJobId;
  if (typeof entry.lastJobId === 'string') lenientEntry.lastJobId = entry.lastJobId;
  if (typeof entry.conversationRef === 'string') lenientEntry.conversationRef = entry.conversationRef;
  if (typeof entry.model === 'string') lenientEntry.model = entry.model;
  if (typeof entry.cwd === 'string') lenientEntry.cwd = entry.cwd;
  if (projectRoot !== undefined) lenientEntry.projectRoot = projectRoot;
  if (typeof entry.createdAt === 'string') lenientEntry.createdAt = entry.createdAt;
  if (typeof entry.lastUsedAt === 'string') lenientEntry.lastUsedAt = entry.lastUsedAt;
  if (typeof entry.version === 'number') lenientEntry.version = entry.version;

  return lenientEntry;
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
  const registry = readJsonFile(discussSourcesPath());
  const parsed = parseDiscussSourcesRegistry(registry);
  if (!parsed) {
    return [];
  }
  return parsed.sources;
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
