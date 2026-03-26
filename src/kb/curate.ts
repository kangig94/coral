import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { kbRoot } from '../client/paths.js';
import {
  errorMessage,
  isNoEntryError,
  isRecord,
  isStringArray,
  nowIsoString,
} from '../shared/mcp-utils.js';
import {
  compareCursor,
  isClaimStale,
  type CurateCursor,
  type CurateState,
  migrateCurateStateIfNeeded,
  readCurateState,
  writeCurateState,
} from './curate-state.js';
import { cleanupTags, countTagSupport, type TagCleanupResult } from './curate-tags.js';
import {
  readKbIndex,
  recordMutationCommitted,
  withKbMutationLock,
  writeKbIndex,
} from './detect.js';
import {
  extractBody,
  deriveNoteIdentity,
  extractTitle,
  parseFrontmatter,
  replaceFrontmatter,
} from './frontmatter.js';
import {
  assertNonEmptyText,
  assertSlug,
  cloneKbIndex,
  markTextIndexStale,
  writeFileAtomic,
} from './mutation-helpers.js';
import { notePathFromName, principlesDir } from './paths.js';
import { extractPrincipleStatement } from './reindex.js';
import type { KbContext, KbIndex } from './types.js';

const CURATE_MIN_CLAIM_SIZE = 10;
const CURATE_MAX_CLAIM_SIZE = 30;
const CLASSIFICATION_BATCH_SIZE = 10;
const CURATE_STALE_REASON = 'KB text snapshot is stale after kb_curate.';
const CURATE_RUNTIME_PROJECT_ROOT = '<curate-runtime>';
const CURATE_TRANSIENT_RETRY_MS = 30 * 60 * 1000;
const CURATE_MISSING_CLI_RETRY_MS = 2 * 60 * 60 * 1000;
const CURATE_MAX_RETRY_MS = 4 * 60 * 60 * 1000;
const DISCOVERY_MIN_CORPUS_SIZE = 50;
const DISCOVERY_PROMPT_BODY_LIMIT = 500;
const DISCOVERY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DISCOVERY_CORPUS_RESET_RATIO = 0.2;

const GITIGNORE_ENTRIES = ['curate-state.json', 'data/'];
const GITIGNORE_HEADER = '# Coral KB runtime (device-local, auto-managed)';

let cachedIsGitRepo: boolean | null = null;

function isGitRepo(dir: string): boolean {
  if (cachedIsGitRepo !== null) return cachedIsGitRepo;
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    cachedIsGitRepo = true;
  } catch {
    cachedIsGitRepo = false;
  }
  return cachedIsGitRepo;
}

function ensureKbGitignore(): void {
  const root = kbRoot();
  const gitignorePath = join(root, '.gitignore');

  try {
    let existing = '';
    try {
      existing = readFileSync(gitignorePath, 'utf-8');
    } catch {
      // file doesn't exist yet — will create
    }
    const lines = existing.split('\n');
    const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.some((line) => line.trim() === entry));
    if (missing.length === 0) return;

    if (existing.length === 0) {
      writeFileSync(gitignorePath, `${GITIGNORE_HEADER}\n${missing.join('\n')}\n`, 'utf-8');
    } else {
      appendFileSync(gitignorePath, `\n${GITIGNORE_HEADER}\n${missing.join('\n')}\n`, 'utf-8');
    }
  } catch {
    // best-effort
  }
}

function gitAutoCommit(message: string): void {
  const root = kbRoot();
  if (!isGitRepo(root)) return;

  try {
    execFileSync('git', ['-C', root, 'add', 'notes/', 'principles/'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    // diff --cached --quiet exits 0 = nothing staged, 1 = staged changes
    try {
      execFileSync('git', ['-C', root, 'diff', '--cached', '--quiet'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return; // nothing staged
    } catch {
      // has staged changes — proceed to commit
    }

    try {
      execFileSync('git', ['-C', root, 'commit', '-m', message], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
    } catch {
      // git config may be missing — retry with author override
      try {
        execFileSync('git', [
          '-C', root,
          '-c', 'user.name=Claude',
          '-c', 'user.email=noreply@anthropic.com',
          'commit', '-m', message,
        ], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
      } catch {
        // best-effort — commit failure doesn't break curate
      }
    }
  } catch {
    // git add failure — best-effort
  }
}

type SpawnCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type SpawnCliFn = (options: {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  pool?: 'default' | 'discuss' | 'curate';
}) => Promise<SpawnCliResult>;

export type CurateClaimedNote = {
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
  mutationSeqAtPromote: number;
};

export type ClassificationAssignment = {
  note: string;
  tags: string[];
  principles: string[];
};

export type DiscoveryProposal = {
  slug: string;
  statement: string;
  notes: string[];
};

type PendingDiscovery = CurateState['pendingDiscoveries'][number];

export type MetadataTarget = {
  note: string;
  mutationSeqAtPromote: number;
  claimTimeUpdatedAt: string;
  addTags?: string[];
  desiredTags?: string[];
  addPrinciples?: string[];
  removeTags?: string[];
  cleanup?: boolean;
};

export type CurateClaim = {
  notes: CurateClaimedNote[];
  through: CurateCursor;
};

type ClaimCandidate = {
  slug: string;
  title: string;
  updatedAt: string;
  cursor: CurateCursor;
};

type LiveMetadataDecision = {
  shouldWrite: boolean;
  nextTags: string[];
  nextPrinciples: string[];
};

type ParsedArrayResult = {
  entries: unknown[];
  parseFailed: boolean;
};

let runtimeStarted = false;
let spawnCliFn: SpawnCliFn | null = null;
let queuedRun = false;
let activeRun: Promise<void> | null = null;
let retryWakeTimer: NodeJS.Timeout | null = null;

class CurateJsonParseError extends Error {
  constructor(phase: 'classification' | 'discovery') {
    super(`Curate ${phase} returned invalid JSON.`);
    this.name = 'CurateJsonParseError';
  }
}

class CurateRunError extends Error {
  readonly through: CurateCursor | null;

  readonly cause: unknown;

  constructor(through: CurateCursor | null, cause: unknown) {
    super(errorMessage(cause));
    this.name = 'CurateRunError';
    this.through = through;
    this.cause = cause;
  }
}

function buildFlatList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

function stripMarkdownCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonArray(raw: string): ParsedArrayResult {
  const normalized = stripMarkdownCodeFences(raw.trim());
  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    return {
      entries: [],
      parseFailed: true,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      entries: [],
      parseFailed: true,
    };
  }

  return {
    entries: parsed,
    parseFailed: false,
  };
}

function uniqueTrimmedList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function buildTagVocabulary(index: KbIndex): string[] {
  const tags = new Set<string>();

  for (const note of Object.values(index.notes)) {
    for (const tag of note.tags) {
      tags.add(tag);
    }
  }

  return [...tags].sort((left, right) => left.localeCompare(right));
}

function buildPrincipleNames(index: KbIndex): string[] {
  return Object.keys(index.principles).sort((left, right) => left.localeCompare(right));
}

function compareOptionalCursor(left: CurateCursor | null, right: CurateCursor): number {
  if (left === null) {
    return -1;
  }

  return compareCursor(left, right);
}

function compareCursorDates(target: string | null, now: string): number {
  if (target === null) {
    return Number.NEGATIVE_INFINITY;
  }

  const targetMs = Date.parse(target);
  if (Number.isNaN(targetMs)) {
    return Number.NEGATIVE_INFINITY;
  }

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return Number.NEGATIVE_INFINITY;
  }

  return targetMs - nowMs;
}

function retryBaseCooldownMs(error: unknown): number {
  const message = errorMessage(error);
  if (message.includes('Failed to spawn claude:') && (message.includes('ENOENT') || message.includes('not found'))) {
    return CURATE_MISSING_CLI_RETRY_MS;
  }

  return CURATE_TRANSIENT_RETRY_MS;
}

function calculateRetryCooldownMs(baseCooldownMs: number, consecutiveFailures: number): number {
  return Math.min(baseCooldownMs * (2 ** consecutiveFailures), CURATE_MAX_RETRY_MS);
}

async function recordCurateFailure(through: CurateCursor | null, error: unknown): Promise<void> {
  await withKbMutationLock(() => {
    const state = readCurateState();
    const attemptedThrough = through ?? state.lastAttemptedThrough;
    if (attemptedThrough === null) {
      if (state.activeClaim === null) {
        return;
      }
      writeCurateState({
        ...state,
        activeClaim: null,
      });
      return;
    }

    const sameAttempt = state.lastAttemptedThrough !== null
      && compareCursor(state.lastAttemptedThrough, attemptedThrough) === 0;
    const priorFailures = sameAttempt ? state.consecutiveFailures : 0;

    writeCurateState({
      ...state,
      lastAttemptedThrough: attemptedThrough,
      retryNotBefore: new Date(
        Date.now() + calculateRetryCooldownMs(retryBaseCooldownMs(error), priorFailures),
      ).toISOString(),
      activeClaim: null,
      consecutiveFailures: priorFailures + 1,
    });
  });
}

async function clearCurateRetryState(): Promise<void> {
  await withKbMutationLock(() => {
    const state = readCurateState();
    if (state.activeClaim === null && state.retryNotBefore === null && state.consecutiveFailures === 0) {
      return;
    }

    writeCurateState({
      ...state,
      retryNotBefore: null,
      activeClaim: null,
      consecutiveFailures: 0,
    });
  });
}

async function hasPendingNotesBeyondCursor(cursor: CurateCursor): Promise<boolean> {
  return withKbMutationLock(() => {
    const index = readKbIndex();
    if (index === null) {
      return false;
    }

    return collectClaimCandidates(index).some((candidate) => compareCursor(candidate.cursor, cursor) > 0);
  });
}

function collectClaimCandidates(index: KbIndex): ClaimCandidate[] {
  return Object.entries(index.notes)
    .flatMap(([slug, noteMeta]) => noteMeta.mutationSeqAtPromote === undefined
      ? []
      : [{
        slug,
        title: noteMeta.title,
        updatedAt: noteMeta.updatedAt,
        cursor: {
          note: slug,
          mutationSeqAtPromote: noteMeta.mutationSeqAtPromote,
        },
      }])
    .sort((left, right) => compareCursor(left.cursor, right.cursor));
}

function readClaimedNote(candidate: ClaimCandidate): CurateClaimedNote {
  const content = readFileSync(notePathFromName(candidate.slug), 'utf-8');

  return {
    slug: candidate.slug,
    title: candidate.title,
    body: extractBody(content),
    updatedAt: candidate.updatedAt,
    mutationSeqAtPromote: candidate.cursor.mutationSeqAtPromote,
  };
}

function pendingExtendsBeyondCursor(
  pendingNotes: ClaimCandidate[],
  cursor: CurateCursor | null,
): boolean {
  if (cursor === null || pendingNotes.length === 0) {
    return false;
  }

  return compareCursor(pendingNotes[pendingNotes.length - 1]!.cursor, cursor) > 0;
}

function cursorFromTarget(target: MetadataTarget): CurateCursor {
  return {
    note: target.note,
    mutationSeqAtPromote: target.mutationSeqAtPromote,
  };
}

function compareMetadataTarget(left: MetadataTarget, right: MetadataTarget): number {
  return compareCursor(cursorFromTarget(left), cursorFromTarget(right));
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function advanceProcessedThrough(
  processedThrough: CurateCursor | null,
  cursorCanAdvance: boolean,
  cursor: CurateCursor,
): CurateCursor | null {
  if (!cursorCanAdvance || compareOptionalCursor(processedThrough, cursor) >= 0) {
    return processedThrough;
  }

  return cursor;
}

function parentAbsorptionTarget(
  tag: string,
  noteTagSet: ReadonlySet<string>,
  tagSupport: ReadonlyMap<string, number>,
): string | null {
  const splitAt = tag.lastIndexOf('-');
  if (splitAt <= 0) {
    return null;
  }

  const core = tag.slice(0, splitAt);
  if (!noteTagSet.has(core)) {
    return null;
  }
  if ((tagSupport.get(core) ?? 0) < 3) {
    return null;
  }

  return core;
}

function hasParentAbsorptionCandidate(
  note: string,
  tags: string[],
  tagSupport: ReadonlyMap<string, number>,
): boolean {
  const domain = deriveNoteIdentity(note).domain;
  const noteTagSet = new Set(tags);

  return tags.some((tag) => tag !== domain && parentAbsorptionTarget(tag, noteTagSet, tagSupport) !== null);
}

function applyParentAbsorption(
  note: string,
  tags: string[],
  tagSupport: ReadonlyMap<string, number>,
): string[] {
  const domain = deriveNoteIdentity(note).domain;
  const noteTagSet = new Set(tags);
  const nextTags = tags.map((tag) => {
    if (tag === domain) {
      return tag;
    }

    return parentAbsorptionTarget(tag, noteTagSet, tagSupport) ?? tag;
  });

  return uniqueTrimmedList(nextTags);
}

function buildLiveMetadataDecision(
  target: MetadataTarget,
  liveTags: string[],
  livePrinciples: string[],
  cleanupTagSupport: ReadonlyMap<string, number>,
): LiveMetadataDecision {
  const addTags = uniqueTrimmedList(target.addTags ?? []);
  const addPrinciples = uniqueTrimmedList(target.addPrinciples ?? []);
  const removeTags = uniqueTrimmedList(target.removeTags ?? []);
  const desiredTags = target.desiredTags === undefined
    ? undefined
    : uniqueTrimmedList(target.desiredTags);

  if (target.cleanup && removeTags.length > 0 && removeTags.some((tag) => !liveTags.includes(tag))) {
    return {
      shouldWrite: false,
      nextTags: [...liveTags],
      nextPrinciples: [...livePrinciples],
    };
  }

  const removeTagSet = new Set(removeTags);
  let nextTags = desiredTags ?? uniqueTrimmedList([
    ...liveTags,
    ...addTags,
  ]).filter((tag) => !removeTagSet.has(tag));
  if (target.cleanup) {
    nextTags = applyParentAbsorption(target.note, nextTags, cleanupTagSupport);
  }

  const nextPrinciples = uniqueTrimmedList([
    ...livePrinciples,
    ...addPrinciples,
  ]);

  return {
    shouldWrite: !sameStringList(nextTags, liveTags) || !sameStringList(nextPrinciples, livePrinciples),
    nextTags,
    nextPrinciples,
  };
}

function getRuntimeKbContext(): KbContext {
  return {
    projectRoot: CURATE_RUNTIME_PROJECT_ROOT,
    kbRoot: kbRoot(),
    adapter: null,
  };
}

function clearRetryWake(): void {
  if (retryWakeTimer !== null) {
    clearTimeout(retryWakeTimer);
    retryWakeTimer = null;
  }
}

function armRetryWake(): void {
  clearRetryWake();

  if (!runtimeStarted) {
    return;
  }

  const state = readCurateState();
  if (state.retryNotBefore === null) {
    return;
  }

  const delayMs = Date.parse(state.retryNotBefore) - Date.now();
  if (Number.isNaN(delayMs) || delayMs <= 0) {
    scheduleCurate();
    return;
  }

  retryWakeTimer = setTimeout(() => {
    retryWakeTimer = null;
    scheduleCurate();
  }, delayMs);
}

function launchQueuedRun(): void {
  if (!runtimeStarted || activeRun !== null || !queuedRun) {
    return;
  }

  queuedRun = false;
  activeRun = (async () => {
    let lastCompletedThrough: CurateCursor | null = null;

    try {
      lastCompletedThrough = await runScheduledCurate(getRuntimeKbContext());
    } catch (error: unknown) {
      const runError = error instanceof CurateRunError
        ? error
        : new CurateRunError(null, error);
      process.stderr.write(`kb_curate: ${errorMessage(runError.cause)}\n`);
      try {
        await recordCurateFailure(runError.through, runError.cause);
      } catch (stateError: unknown) {
        process.stderr.write(`kb_curate: failed to persist retry state: ${errorMessage(stateError)}\n`);
      }
    } finally {
      activeRun = null;
      try {
        armRetryWake();
      } catch (error: unknown) {
        process.stderr.write(`kb_curate: ${errorMessage(error)}\n`);
      }
      if (queuedRun) {
        queueMicrotask(() => {
          launchQueuedRun();
        });
        return;
      }
      if (lastCompletedThrough !== null) {
        try {
          if (await hasPendingNotesBeyondCursor(lastCompletedThrough)) {
            queuedRun = true;
          }
        } catch (error: unknown) {
          process.stderr.write(`kb_curate: ${errorMessage(error)}\n`);
        }
      }
      if (queuedRun) {
        queueMicrotask(() => {
          launchQueuedRun();
        });
      }
    }
  })();
}

export async function startCurateRuntime(kb?: KbContext): Promise<void> {
  void kb;

  if (runtimeStarted) {
    return;
  }

  ensureKbGitignore();
  await migrateCurateStateIfNeeded();
  runtimeStarted = true;
  armRetryWake();
  scheduleCurate();
}

export function scheduleCurate(kb?: KbContext): void {
  void kb;

  queuedRun = true;
  if (!runtimeStarted) {
    return;
  }

  clearRetryWake();
  queueMicrotask(() => {
    launchQueuedRun();
  });
}

export function curateRunActive(): boolean {
  return queuedRun || activeRun !== null || retryWakeTimer !== null;
}

export function setCurateSpawnFn(fn: SpawnCliFn | null): void {
  spawnCliFn = fn;
}

export async function claimCurateRun(kb: KbContext, today: string): Promise<CurateClaim | null> {
  void kb;

  return withKbMutationLock(() => {
    const state = readCurateState();
    const now = nowIsoString();

    if (state.activeClaim !== null && !isClaimStale(state, now)) {
      return null;
    }

    const index = readKbIndex();
    if (index === null) {
      return null;
    }

    const pendingNotes = collectClaimCandidates(index)
      .filter((candidate) => compareOptionalCursor(state.processedThrough, candidate.cursor) < 0);
    if (pendingNotes.length === 0) {
      return null;
    }

    const firstPassClaim = (
      (today !== state.lastRunDay && pendingNotes.length >= CURATE_MIN_CLAIM_SIZE)
      || pendingNotes.length >= CURATE_MAX_CLAIM_SIZE
    );
    const retryBlocked = compareCursorDates(state.retryNotBefore, now) > 0
      && !pendingExtendsBeyondCursor(pendingNotes, state.lastAttemptedThrough);
    const retryClaim = state.lastAttemptedThrough !== null
      && state.retryNotBefore !== null
      && !retryBlocked;

    if (!firstPassClaim && !retryClaim) {
      return null;
    }

    const claimedCandidates = pendingNotes.slice(0, CURATE_MAX_CLAIM_SIZE);
    const through = claimedCandidates[claimedCandidates.length - 1]?.cursor;
    if (through === undefined) {
      return null;
    }

    const claim: CurateClaim = {
      notes: claimedCandidates.map(readClaimedNote),
      through,
    };
    const freshPendingSuffix = pendingExtendsBeyondCursor(pendingNotes, state.lastAttemptedThrough);

    writeCurateState({
      ...state,
      retryNotBefore: null,
      activeClaim: {
        through,
        startedAt: now,
      },
      lastAttemptedThrough: through,
      consecutiveFailures: freshPendingSuffix ? 0 : state.consecutiveFailures,
      ...(firstPassClaim ? { lastRunDay: today } : {}),
    });

    return claim;
  });
}

export function buildClassificationPrompt(
  notes: CurateClaimedNote[],
  tagVocab: string[],
  principleNames: string[],
): string {
  const noteBlocks = notes.map((note) => `## ${note.slug}\n${note.title}\n${note.body}`);

  return [
    'Return raw JSON only. Do not include any preamble, explanation, or code fences.',
    '',
    'Tag vocabulary:',
    buildFlatList(tagVocab),
    '',
    'Principle names:',
    buildFlatList(principleNames),
    '',
    ...noteBlocks,
    '',
    'Return a JSON array: [{ "note": "<slug>", "tags": ["<tag>", ...], "principles": ["<principle>", ...] }]',
  ].join('\n');
}

function classifyParsedEntries(
  entries: unknown[],
  noteMap: Map<string, true>,
): ClassificationAssignment[] {
  const assignments: ClassificationAssignment[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      typeof entry.note !== 'string'
      || !isStringArray(entry.tags)
      || !isStringArray(entry.principles)
      || !noteMap.has(entry.note)
    ) {
      continue;
    }
    assignments.push({
      note: entry.note,
      tags: [...entry.tags],
      principles: [...entry.principles],
    });
  }

  return assignments;
}

export function parseClassificationResponse(
  raw: string,
  noteMap: Map<string, true>,
): ClassificationAssignment[] {
  const { entries, parseFailed } = parseJsonArray(raw);
  return parseFailed ? [] : classifyParsedEntries(entries, noteMap);
}

export function chunkNotes<T>(notes: T[], batchSize = CLASSIFICATION_BATCH_SIZE): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }

  const chunks: T[][] = [];
  for (let index = 0; index < notes.length; index += batchSize) {
    chunks.push(notes.slice(index, index + batchSize));
  }

  return chunks;
}

export async function invokeClaude(prompt: string): Promise<string> {
  if (spawnCliFn === null) {
    throw new Error('Curate spawnCli callback is not configured.');
  }

  const result = await spawnCliFn({
    provider: 'claude',
    command: 'claude',
    args: ['-p'],
    prompt,
    pool: 'curate',
  });

  if (result.aborted) {
    throw new Error('Claude invocation aborted during curate classification.');
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(stderr ? `Claude exited with code ${result.code}: ${stderr}` : `Claude exited with code ${result.code}`);
  }

  return result.stdout;
}

export async function runClassificationBatches(
  kb: KbContext,
  claim: CurateClaim,
  index: KbIndex,
): Promise<ClassificationAssignment[]> {
  void kb;

  const rawAssignments: ClassificationAssignment[] = [];
  const tagVocab = buildTagVocabulary(index);
  const principleNames = buildPrincipleNames(index);

  for (const batch of chunkNotes(claim.notes, CLASSIFICATION_BATCH_SIZE)) {
    const prompt = buildClassificationPrompt(batch, tagVocab, principleNames);
    const raw = await invokeClaude(prompt);
    const { entries, parseFailed } = parseJsonArray(raw);
    if (parseFailed) {
      throw new CurateJsonParseError('classification');
    }
    const noteMap = new Map<string, true>(batch.map((note) => [note.slug, true] as const));
    rawAssignments.push(...classifyParsedEntries(entries, noteMap));
  }

  return rawAssignments;
}

export function validateAssignments(
  proposals: ClassificationAssignment[],
  index: KbIndex,
  claimedNotes: CurateClaimedNote[],
): ClassificationAssignment[] {
  const existingTagVocabulary = new Set<string>();
  for (const noteMeta of Object.values(index.notes)) {
    for (const tag of noteMeta.tags) {
      existingTagVocabulary.add(tag);
    }
  }

  const claimedOrder = claimedNotes.map((note) => note.slug);
  const claimedSet = new Set(claimedOrder);
  const mergedByNote = new Map<string, ClassificationAssignment>();

  for (const proposal of proposals) {
    if (!claimedSet.has(proposal.note) || index.notes[proposal.note] === undefined) {
      continue;
    }

    const existing = mergedByNote.get(proposal.note);
    if (existing === undefined) {
      mergedByNote.set(proposal.note, {
        note: proposal.note,
        tags: uniqueTrimmedList(proposal.tags),
        principles: uniqueTrimmedList(proposal.principles),
      });
      continue;
    }

    existing.tags = uniqueTrimmedList([...existing.tags, ...proposal.tags]);
    existing.principles = uniqueTrimmedList([...existing.principles, ...proposal.principles]);
  }

  const newTagSupport = new Map<string, number>();
  for (const proposal of mergedByNote.values()) {
    const seenNewTags = new Set<string>();
    for (const tag of proposal.tags) {
      if (existingTagVocabulary.has(tag) || seenNewTags.has(tag)) {
        continue;
      }
      seenNewTags.add(tag);
      newTagSupport.set(tag, (newTagSupport.get(tag) ?? 0) + 1);
    }
  }

  const validated: ClassificationAssignment[] = [];
  for (const slug of claimedOrder) {
    const proposal = mergedByNote.get(slug);
    if (proposal === undefined) {
      continue;
    }

    const domain = deriveNoteIdentity(slug).domain;
    const tags = uniqueTrimmedList([
      domain,
      ...proposal.tags.filter((tag) => existingTagVocabulary.has(tag) || (newTagSupport.get(tag) ?? 0) >= 3),
    ]);
    const principles = uniqueTrimmedList(
      proposal.principles.filter((principle) => index.principles[principle] !== undefined),
    );

    validated.push({
      note: slug,
      tags,
      principles,
    });
  }

  return validated;
}

export function buildMetadataTargets(
  validatedAssignments: ClassificationAssignment[],
  index: KbIndex,
  claimedNotes: CurateClaimedNote[],
): MetadataTarget[] {
  const assignmentsByNote = new Map(
    validatedAssignments.map((assignment) => [assignment.note, assignment] as const),
  );

  return claimedNotes
    .map((claimedNote) => {
      const claimTimeMeta = index.notes[claimedNote.slug];
      const existingTags = new Set(claimTimeMeta?.tags ?? []);
      const existingPrinciples = new Set(claimTimeMeta?.principles ?? []);
      const assignment = assignmentsByNote.get(claimedNote.slug);
      const addTags = uniqueTrimmedList(
        (assignment?.tags ?? []).filter((tag) => !existingTags.has(tag)),
      );
      const addPrinciples = uniqueTrimmedList(
        (assignment?.principles ?? []).filter((principle) => !existingPrinciples.has(principle)),
      );

      return {
        note: claimedNote.slug,
        mutationSeqAtPromote: claimedNote.mutationSeqAtPromote,
        claimTimeUpdatedAt: claimedNote.updatedAt,
        ...(addTags.length === 0 ? {} : { addTags }),
        ...(addPrinciples.length === 0 ? {} : { addPrinciples }),
      };
    })
    .sort(compareMetadataTarget);
}

function applyGlobalCleanup(
  note: string,
  tags: string[],
  cleanup: TagCleanupResult,
): string[] {
  const domain = deriveNoteIdentity(note).domain;

  return uniqueTrimmedList(tags.flatMap((tag) => {
    if (tag === domain) {
      return [tag];
    }

    const replacement = cleanup.globalReplacements.get(tag);
    if (replacement !== undefined) {
      return [replacement];
    }
    if (cleanup.globalDeletions.has(tag)) {
      return [];
    }

    return [tag];
  }));
}

function buildCleanupTargets(
  index: KbIndex,
  cohortNotes: string[],
  cleanup: TagCleanupResult,
): MetadataTarget[] {
  const tagSupport = countTagSupport(index);
  const targets: MetadataTarget[] = [];

  for (const slug of cohortNotes) {
    const noteMeta = index.notes[slug];
    if (noteMeta === undefined || noteMeta.mutationSeqAtPromote === undefined) {
      continue;
    }

    const desiredTags = applyGlobalCleanup(slug, noteMeta.tags, cleanup);
    const desiredSet = new Set(desiredTags);
    const removeTags = noteMeta.tags.filter((tag) => !desiredSet.has(tag));
    const parentAbsorptionPending = hasParentAbsorptionCandidate(slug, desiredTags, tagSupport);

    if (!parentAbsorptionPending && sameStringList(desiredTags, noteMeta.tags)) {
      continue;
    }

    targets.push({
      note: slug,
      mutationSeqAtPromote: noteMeta.mutationSeqAtPromote,
      claimTimeUpdatedAt: noteMeta.updatedAt,
      desiredTags,
      cleanup: true,
      ...(removeTags.length === 0 ? {} : { removeTags }),
    });
  }

  return targets.sort(compareMetadataTarget);
}

export async function commitMetadataTargets(
  kb: KbContext,
  targets: MetadataTarget[],
): Promise<void> {
  void kb;

  const sortedTargets = [...targets].sort(compareMetadataTarget);

  await withKbMutationLock(async () => {
    const state = readCurateState();
    const currentIndex = cloneKbIndex(readKbIndex());
    const nextIndex = cloneKbIndex(currentIndex);
    const cleanupTagSupport = countTagSupport(currentIndex);
    let processedThrough = state.processedThrough;
    let cursorCanAdvance = true;
    let wroteMarkdown = false;

    for (const target of sortedTargets) {
      const cursor = cursorFromTarget(target);
      const notePath = notePathFromName(target.note);
      let raw: string;

      try {
        raw = readFileSync(notePath, 'utf-8');
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
          continue;
        }
        throw error;
      }

      const liveFrontmatter = parseFrontmatter(raw);
      if (liveFrontmatter.updatedAt !== target.claimTimeUpdatedAt) {
        cursorCanAdvance = false;
        continue;
      }

      const metadataDecision = buildLiveMetadataDecision(
        target,
        liveFrontmatter.tags,
        liveFrontmatter.principles,
        cleanupTagSupport,
      );
      if (!metadataDecision.shouldWrite) {
        processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
        continue;
      }

      const nextFrontmatter = {
        tags: metadataDecision.nextTags,
        principles: metadataDecision.nextPrinciples,
        source: liveFrontmatter.source,
        createdAt: liveFrontmatter.createdAt,
        updatedAt: liveFrontmatter.updatedAt,
        mutationSeqAtPromote: liveFrontmatter.mutationSeqAtPromote ?? target.mutationSeqAtPromote,
      };

      writeFileAtomic(notePath, replaceFrontmatter(raw, nextFrontmatter));
      recordMutationCommitted();
      wroteMarkdown = true;

      const existingIndexNote = nextIndex.notes[target.note];
      nextIndex.notes[target.note] = {
        title: existingIndexNote?.title ?? extractTitle(raw),
        tags: [...metadataDecision.nextTags],
        principles: [...metadataDecision.nextPrinciples],
        source: [...liveFrontmatter.source],
        createdAt: liveFrontmatter.createdAt,
        updatedAt: liveFrontmatter.updatedAt,
        mutationSeqAtPromote: nextFrontmatter.mutationSeqAtPromote,
      };

      processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
    }

    const nextState = {
      ...state,
      processedThrough,
      activeClaim: null,
    };

    let failure: unknown = null;

    if (wroteMarkdown) {
      try {
        writeKbIndex(nextIndex);
      } catch (error: unknown) {
        failure ??= error;
      }
    }

    try {
      writeCurateState(nextState);
    } catch (error: unknown) {
      failure ??= error;
    }

    if (wroteMarkdown) {
      try {
        await markTextIndexStale(CURATE_STALE_REASON);
      } catch (error: unknown) {
        failure ??= error;
      }
    }

    if (failure !== null) {
      throw failure;
    }
  });
}

function truncateDiscoveryBody(body: string): string {
  return body.slice(0, DISCOVERY_PROMPT_BODY_LIMIT);
}

function collectEligibleDiscoveryNotes(
  index: KbIndex,
  processedThrough: CurateCursor,
): CurateClaimedNote[] {
  const eligible: CurateClaimedNote[] = [];

  for (const candidate of collectClaimCandidates(index)) {
    if (compareCursor(candidate.cursor, processedThrough) > 0) {
      continue;
    }

    const noteMeta = index.notes[candidate.slug];
    if (noteMeta === undefined || noteMeta.principles.length > 0) {
      continue;
    }

    try {
      eligible.push(readClaimedNote(candidate));
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        continue;
      }
      throw error;
    }
  }

  return eligible;
}

export function buildDiscoveryPrompt(
  notes: CurateClaimedNote[],
  existingPrinciples: string[],
): string {
  const noteBlocks = notes.map((note) => `## ${note.slug}\n${note.title}\n${truncateDiscoveryBody(note.body)}`);

  return [
    'Return raw JSON only. Do not include any preamble, explanation, or code fences.',
    '',
    'Existing principle names. Do not duplicate them:',
    buildFlatList(existingPrinciples),
    '',
    ...noteBlocks,
    '',
    'Return a JSON array: [{ "slug": "<kebab-case>", "statement": "<one-sentence principle>", "notes": ["<slug>", ...] }]',
  ].join('\n');
}

function extractDiscoveryProposals(entries: unknown[]): DiscoveryProposal[] {
  const proposals: DiscoveryProposal[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || typeof entry.slug !== 'string'
      || typeof entry.statement !== 'string'
      || !isStringArray(entry.notes)
    ) {
      continue;
    }

    proposals.push({
      slug: entry.slug,
      statement: entry.statement,
      notes: [...entry.notes],
    });
  }

  return proposals;
}

export function parseDiscoveryResponse(raw: string): DiscoveryProposal[] {
  const { entries, parseFailed } = parseJsonArray(raw);
  return parseFailed ? [] : extractDiscoveryProposals(entries);
}

function normalizeDiscoverySlug(raw: string): string | null {
  try {
    return assertSlug(raw, 'slug');
  } catch {
    return null;
  }
}

export function validateDiscoveryProposals(
  proposals: DiscoveryProposal[],
  eligibleNotes: CurateClaimedNote[],
  existingPrinciples: string[],
): DiscoveryProposal[] {
  const eligibleSet = new Set(eligibleNotes.map((note) => note.slug));
  const existingPrincipleSet = new Set(existingPrinciples);
  const seenSlugs = new Set<string>();
  const validated: DiscoveryProposal[] = [];

  for (const proposal of proposals) {
    const slug = normalizeDiscoverySlug(proposal.slug);
    if (slug === null || existingPrincipleSet.has(slug) || seenSlugs.has(slug)) {
      continue;
    }
    seenSlugs.add(slug);

    const statement = proposal.statement.trim();
    if (!statement) {
      continue;
    }

    const notes = uniqueTrimmedList(
      proposal.notes.filter((note) => eligibleSet.has(note)),
    );
    if (notes.length < 3) {
      continue;
    }

    validated.push({
      slug,
      statement,
      notes,
    });
  }

  return validated;
}

export function serializePrincipleDocument(statement: string, createdAt: string): string {
  const normalizedStatement = assertNonEmptyText(statement, 'statement');
  const normalizedCreatedAt = assertNonEmptyText(createdAt, 'createdAt');

  return [
    '---',
    `createdAt: ${normalizedCreatedAt}`,
    `updatedAt: ${normalizedCreatedAt}`,
    '---',
    '',
    normalizedStatement,
    '',
  ].join('\n');
}

function principlePathFromName(principle: string): string {
  return join(principlesDir(), `${assertSlug(principle, 'principle')}.md`);
}

function discoveryCorpusChangedEnough(state: CurateState, corpusSize: number): boolean {
  if (state.lastDiscoveryCorpusSize === 0) {
    return corpusSize > 0;
  }

  return Math.abs(corpusSize - state.lastDiscoveryCorpusSize) / state.lastDiscoveryCorpusSize >= DISCOVERY_CORPUS_RESET_RATIO;
}

function discoveryAllowed(state: CurateState, corpusSize: number, today: string): boolean {
  if (corpusSize < DISCOVERY_MIN_CORPUS_SIZE) {
    return false;
  }
  if (state.lastDiscoveryDay === null) {
    return true;
  }
  if (discoveryCorpusChangedEnough(state, corpusSize)) {
    return true;
  }

  const lastAttemptMs = Date.parse(state.lastDiscoveryDay);
  if (Number.isNaN(lastAttemptMs)) {
    return true;
  }

  return Date.parse(today) - lastAttemptMs >= DISCOVERY_COOLDOWN_MS;
}

async function recordDiscoveryAttempt(corpusSize: number, today: string): Promise<void> {
  await withKbMutationLock(() => {
    const state = readCurateState();
    writeCurateState({
      ...state,
      lastDiscoveryCorpusSize: corpusSize,
      lastDiscoveryDay: today,
    });
  });
}

async function addPendingDiscovery(entry: PendingDiscovery): Promise<void> {
  await withKbMutationLock(() => {
    const state = readCurateState();
    const alreadyPending = state.pendingDiscoveries.some((pending) => pending.principle === entry.principle && pending.statement === entry.statement);
    if (alreadyPending) {
      return;
    }

    writeCurateState({
      ...state,
      pendingDiscoveries: [...state.pendingDiscoveries, entry],
    });
  });
}

async function removePendingDiscovery(entry: PendingDiscovery): Promise<void> {
  await withKbMutationLock(() => {
    const state = readCurateState();
    writeCurateState({
      ...state,
      pendingDiscoveries: state.pendingDiscoveries.filter((pending) => !(
        pending.principle === entry.principle
        && pending.statement === entry.statement
        && sameStringList(pending.notes, entry.notes)
        && pending.createdAt === entry.createdAt
      )),
    });
  });
}

async function ensurePrincipleDocument(entry: PendingDiscovery): Promise<'ready' | 'conflict'> {
  return withKbMutationLock(async () => {
    const principlePath = principlePathFromName(entry.principle);
    const nextIndex = cloneKbIndex(readKbIndex());

    if (existsSync(principlePath)) {
      const liveStatement = extractPrincipleStatement(readFileSync(principlePath, 'utf-8'));
      if (liveStatement !== entry.statement) {
        return 'conflict';
      }

      if (nextIndex.principles[entry.principle] !== entry.statement) {
        nextIndex.principles[entry.principle] = entry.statement;
        writeKbIndex(nextIndex);
        await markTextIndexStale(CURATE_STALE_REASON);
      }

      return 'ready';
    }

    recordMutationCommitted();
    writeFileAtomic(
      principlePath,
      serializePrincipleDocument(entry.statement, entry.createdAt),
    );
    nextIndex.principles[entry.principle] = entry.statement;
    writeKbIndex(nextIndex);
    await markTextIndexStale(CURATE_STALE_REASON);
    return 'ready';
  });
}

function buildPrincipleAssignmentTargets(
  principle: string,
  notes: string[],
  index: KbIndex,
  processedThrough: CurateCursor,
): MetadataTarget[] {
  const targets: MetadataTarget[] = [];

  for (const note of notes) {
    const noteMeta = index.notes[note];
    if (noteMeta === undefined || noteMeta.mutationSeqAtPromote === undefined) {
      continue;
    }

    const cursor = {
      note,
      mutationSeqAtPromote: noteMeta.mutationSeqAtPromote,
    };
    if (compareCursor(cursor, processedThrough) > 0 || noteMeta.principles.includes(principle)) {
      continue;
    }

    targets.push({
      note,
      mutationSeqAtPromote: noteMeta.mutationSeqAtPromote,
      claimTimeUpdatedAt: noteMeta.updatedAt,
      addPrinciples: [principle],
    });
  }

  return targets.sort(compareMetadataTarget);
}

function pendingDiscoverySatisfied(
  entry: PendingDiscovery,
  processedThrough: CurateCursor,
): boolean {
  const index = readKbIndex() ?? { notes: {}, principles: {} };

  return entry.notes.every((note) => {
    const noteMeta = index.notes[note];
    if (noteMeta === undefined) {
      return true;
    }
    if (noteMeta.mutationSeqAtPromote === undefined) {
      return false;
    }
    if (compareCursor({
      note,
      mutationSeqAtPromote: noteMeta.mutationSeqAtPromote,
    }, processedThrough) > 0) {
      return false;
    }

    return noteMeta.principles.includes(entry.principle);
  });
}

async function finalizePendingDiscovery(
  kb: KbContext,
  entry: PendingDiscovery,
  processedThrough: CurateCursor,
): Promise<void> {
  const principleDocumentState = await ensurePrincipleDocument(entry);
  if (principleDocumentState === 'conflict') {
    await removePendingDiscovery(entry);
    return;
  }

  const targets = buildPrincipleAssignmentTargets(
    entry.principle,
    entry.notes,
    cloneKbIndex(readKbIndex()),
    processedThrough,
  );
  if (targets.length > 0) {
    await commitMetadataTargets(kb, targets);
  }

  if (pendingDiscoverySatisfied(entry, processedThrough)) {
    await removePendingDiscovery(entry);
  }
}

async function drainPendingDiscoveries(
  kb: KbContext,
  processedThrough: CurateCursor,
): Promise<void> {
  const { pendingDiscoveries } = readCurateState();

  for (const entry of pendingDiscoveries) {
    await finalizePendingDiscovery(kb, entry, processedThrough);
  }
}

export async function runPrincipleDiscovery(
  kb: KbContext,
  index: KbIndex,
  processedThrough: CurateCursor,
): Promise<void> {
  void index;

  await drainPendingDiscoveries(kb, processedThrough);

  const currentIndex = cloneKbIndex(readKbIndex());
  const eligibleNotes = collectEligibleDiscoveryNotes(currentIndex, processedThrough);
  const today = nowIsoString().slice(0, 10);
  const state = readCurateState();

  if (!discoveryAllowed(state, eligibleNotes.length, today)) {
    return;
  }

  await recordDiscoveryAttempt(eligibleNotes.length, today);

  const prompt = buildDiscoveryPrompt(eligibleNotes, buildPrincipleNames(currentIndex));
  const raw = await invokeClaude(prompt);
  const { entries, parseFailed } = parseJsonArray(raw);
  if (parseFailed) {
    throw new CurateJsonParseError('discovery');
  }
  const proposals = validateDiscoveryProposals(
    extractDiscoveryProposals(entries),
    eligibleNotes,
    buildPrincipleNames(currentIndex),
  );

  for (const proposal of proposals) {
    const entry: PendingDiscovery = {
      principle: proposal.slug,
      statement: proposal.statement,
      notes: [...proposal.notes],
      createdAt: nowIsoString(),
    };

    await addPendingDiscovery(entry);
    await finalizePendingDiscovery(kb, entry, processedThrough);
  }
}

async function runScheduledCurate(kb: KbContext): Promise<CurateCursor | null> {
  let lastCompletedThrough: CurateCursor | null = null;

  while (true) {
    const claim = await claimCurateRun(kb, nowIsoString().slice(0, 10));
    if (claim === null) {
      return lastCompletedThrough;
    }

    try {
      const claimIndex = cloneKbIndex(readKbIndex());
      const rawAssignments = await runClassificationBatches(kb, claim, claimIndex);
      const validatedAssignments = validateAssignments(rawAssignments, claimIndex, claim.notes);
      const metadataTargets = buildMetadataTargets(validatedAssignments, claimIndex, claim.notes);
      await commitMetadataTargets(kb, metadataTargets);
      gitAutoCommit(`curate: classify ${claim.notes.length} notes (tags + principles)`);

      const postPhaseOneState = readCurateState();
      const postPhaseOneProcessedThrough = postPhaseOneState.processedThrough;
      const postPhaseOneIndex = cloneKbIndex(readKbIndex());

      if (
        postPhaseOneProcessedThrough !== null
        && collectEligibleDiscoveryNotes(postPhaseOneIndex, postPhaseOneProcessedThrough).length >= DISCOVERY_MIN_CORPUS_SIZE
      ) {
        await runPrincipleDiscovery(
          kb,
          postPhaseOneIndex,
          postPhaseOneProcessedThrough,
        );
        gitAutoCommit('curate: discover principles from principle-less notes');
      }

      const cleanupResult = cleanupTags(
        postPhaseOneIndex,
        claim.notes.map((note) => note.slug),
      );
      const cleanupTargets = buildCleanupTargets(
        postPhaseOneIndex,
        claim.notes.map((note) => note.slug),
        cleanupResult,
      );
      if (cleanupTargets.length > 0) {
        await commitMetadataTargets(kb, cleanupTargets);
        gitAutoCommit(`curate: cleanup tags for ${cleanupTargets.length} notes`);
      }

      await clearCurateRetryState();
      lastCompletedThrough = claim.through;
    } catch (error: unknown) {
      throw new CurateRunError(claim.through, error);
    }
  }
}
