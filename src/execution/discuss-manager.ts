import { z } from 'zod';

import {
  makeEvent,
  type DiscussDomainEvent,
  type FollowUpQueueItem,
  type PersistedDiscussAgentRun,
  type PersistedDiscussSnapshot,
  type SessionCreatedAgentExecutionConfig,
} from '../discuss/events.js';
import { reduceDiscussEvent } from '../discuss/reducer.js';
import {
  DEFAULT_MAX_EPOCHS,
  decideBid,
  decideBidRoundClose,
  decideEnd,
  decideEpochSummary,
  decideExpel,
  decideSessionCreate,
  decideSpeech,
  decideSpeechTimeout,
  decideSynthesis,
  resolveAgentName,
} from '../discuss/state-machine.js';
import type {
  BidResult,
  DiscussCreateInput,
  DiscussState,
  EndReason,
  Result,
  SpeechResult,
  TranscriptEntry,
} from '../discuss/types.js';
import { renderEntries, renderHeader } from '../discuss/transcript.js';
import { nowIsoString } from '../discuss/util/time.js';
import { discussEventLogPath } from '../client/paths.js';
import { readDiscussEventLog, readStatusRecord } from '../client/readers.js';
import type { CallerContext } from './request-context.js';
import {
  buildBidPrompt,
  buildFirstTurnInstruction,
  buildSpeechPrompt,
} from './discuss-prompts.js';
import {
  DiscussSessionStore,
  DiscussStaleWriteError,
} from './discuss-session-store.js';
import type { ExecutionService } from './service.js';
import { buildWatchEvents } from '../discuss/projections.js';

export type AgentConfig = {
  name: string;
  persona: string;
  participation?: 'required' | 'observer';
  provider?: string;
  model?: string;
};

export type DiscussConfig = {
  min_bid_delay_ms?: number;
};

export type WatchEvent = {
  type: 'bid_resolved' | 'speech_done' | 'epoch_transition' | 'session_ended';
  data: Record<string, unknown>;
  ts: number;
};

export type LiveDiscussSession = {
  snapshot: PersistedDiscussSnapshot;
  controller: AbortController;
  watchSubscribers: Set<(event: WatchEvent) => void>;
  watchHistory: WatchEvent[];
  abortEnded: boolean;
  loopState: { running: boolean };
};

export type DiscussSession = LiveDiscussSession;
export type AgentRun = PersistedDiscussAgentRun;

const DEFAULT_DISCUSS_PROVIDER = 'codex';
const DEFAULT_FACILITATOR_PROVIDER = 'claude';
const ABORT_REASON = 'abort';
const BID_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000;
const SPEECH_TIMEOUT_MS = 5 * 60 * 1000;
const EPOCH_EVAL_TIMEOUT_MS = 5 * 60 * 1000;
const CONVERGENCE_THRESHOLD = 7;
const MAX_BID_ATTEMPTS = 3;
const MAX_FOLLOW_UP_ATTEMPTS = 3;
const MUST_ANSWER_SEPARATOR = '\u0000';
const RETRYABLE_ATTEMPT_OUTCOMES = new Set([
  'execution_error',
  'recovery_failed',
  'recovery_missing',
  'retryable_parse_error',
]);
const CONTINUE_TURN_INSTRUCTION =
  'You are participating in a backend-managed multi-agent discussion. Follow the prompt exactly and return only the requested format.';
const FOLLOW_UP_TURN_INSTRUCTION =
  'You are answering a moderator follow-up in an ongoing discussion. Respond with the answer text only. Do not use markdown or code fences.';
const PURPOSE_BID = 'bid';
const PURPOSE_SPEECH = 'speech';
const PURPOSE_EPOCH_EVALUATION = 'epoch_evaluation';
const PURPOSE_FOLLOW_UP = 'follow_up';
const PURPOSE_SYNTHESIS = 'synthesis';

const BidSchema = z.object({
  score: z.number().int().min(0).max(100),
  thought: z.string(),
});

const EpochEvaluationSchema = z.object({
  convergence: z.number().min(0).max(10),
  summary: z.string(),
  must_answer: z.array(z.object({
    to: z.string(),
    question: z.string(),
  })),
});

type MustAnswerItem = {
  to: string;
  question: string;
};

type EpochEvaluation = {
  convergence: number;
  summary: string;
  mustAnswer: MustAnswerItem[];
};

type BidOutcome = {
  agentName: string;
  score: number;
  thought: string;
  executionFailure: boolean;
  shouldExpel: boolean;
  answeredCarryForward: boolean;
};

type CommitSuccess = {
  ok: true;
  previous: PersistedDiscussSnapshot;
  snapshot: PersistedDiscussSnapshot;
  events: DiscussDomainEvent[];
};

type CommitFailure = {
  ok: false;
  error: string;
  detail?: Record<string, unknown>;
};

type CommitResult = CommitSuccess | CommitFailure;

type AttemptSuccess = {
  ok: true;
  attempt: number;
  jobId: string;
  content: string;
  nonResumable: boolean;
};

type AttemptFailure = {
  ok: false;
  attempt?: number;
  consumedAttempt: boolean;
  message: string;
};

type AttemptResult = AttemptSuccess | AttemptFailure;

type FacilitatorRun = {
  agentName: string;
  provider: string;
  model?: string;
};

export class DiscussManagerError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: string, detail?: Record<string, unknown>) {
    super(code);
    this.name = 'DiscussManagerError';
    this.code = code;
    this.detail = detail;
  }
}

function unwrapResult<T>(result: Result<T>, action: string): T {
  if (result.ok) {
    return result.value;
  }
  throw new DiscussManagerError(result.error, result.detail);
}

function isCommitSuccess(result: CommitResult): result is CommitSuccess {
  return result.ok;
}

function isAttemptSuccess(result: AttemptResult): result is AttemptSuccess {
  return result.ok;
}

function isLivePhase(phase: string): boolean {
  return phase === 'queued' || phase === 'launching' || phase === 'running';
}

function isRetryableAttemptOutcome(outcome: string | undefined): boolean {
  return outcome !== undefined && RETRYABLE_ATTEMPT_OUTCOMES.has(outcome);
}

function stripFencedCodeBlock(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function buildBidRetryPrompt(basePrompt: string, rawResponse: string, failure: string): string {
  return [
    basePrompt,
    'Your previous response could not be accepted.',
    `Failure: ${failure}`,
    'Return ONLY valid JSON in this exact shape: {"score": 0-100, "thought": "..."}',
    'Previous response:',
    rawResponse,
  ].join('\n\n');
}

function buildFollowUpRetryPrompt(basePrompt: string, rawResponse: string, failure: string): string {
  return [
    basePrompt,
    'Your previous response could not be accepted.',
    `Failure: ${failure}`,
    'Return only the answer text. Do not use markdown or code fences.',
    'Previous response:',
    rawResponse,
  ].join('\n\n');
}

function parseBidResponse(content: string): { score: number; thought: string } {
  const parsed = JSON.parse(stripFencedCodeBlock(content));
  return BidSchema.parse(parsed);
}

function normalizeFollowUpAnswer(content: string): string {
  return stripFencedCodeBlock(content).trim();
}

function lastSpeech(transcript: TranscriptEntry[]): { speaker: string; content: string } | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry.type === 'speech') {
      return { speaker: entry.agent, content: entry.content };
    }
  }
  return null;
}

function readDiscussMaxEpochs(): number {
  const raw = Number.parseInt(process.env.CORAL_DISCUSS_MAX_EPOCHS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > 10) {
    return DEFAULT_MAX_EPOCHS;
  }
  return raw;
}

function renderTranscriptText(state: DiscussState): string {
  return `${renderHeader(state.topic, state.agents)}${renderEntries(state.transcript, state.agents)}`;
}

function applyEventsLocally(
  snapshot: PersistedDiscussSnapshot,
  events: DiscussDomainEvent[],
): PersistedDiscussSnapshot {
  return events.reduce((current, event) => reduceDiscussEvent(current, event), snapshot);
}

function normalizeModel(model: string | undefined): string | undefined {
  if (model === undefined || model.length === 0) {
    return undefined;
  }
  return model;
}

function encodeCarryForward(item: MustAnswerItem): string {
  return `${item.to}${MUST_ANSWER_SEPARATOR}${item.question}`;
}

function parseMustAnswerItem(value: string): MustAnswerItem | null {
  const separator = value.indexOf(MUST_ANSWER_SEPARATOR);
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }

  return {
    to: value.slice(0, separator),
    question: value.slice(separator + 1),
  };
}

export class DiscussManager {
  private readonly sessions = new Map<string, LiveDiscussSession>();
  private readonly projectRoot: string;
  private readonly service: ExecutionService;
  private readonly store: DiscussSessionStore;

  constructor(projectRoot: string, service: ExecutionService, store: DiscussSessionStore) {
    this.projectRoot = projectRoot;
    this.service = service;
    this.store = store;
  }

  hasLiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (!session.controller.signal.aborted && session.snapshot.state.status !== 'ended') {
        return true;
      }
    }
    return false;
  }

  getSession(sessionId: string): LiveDiscussSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Array<[string, LiveDiscussSession]> {
    return [...this.sessions.entries()];
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  subscribe(sessionId: string, callback: (event: WatchEvent) => void): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return () => {};
    }

    session.watchSubscribers.add(callback);
    return () => {
      session.watchSubscribers.delete(callback);
    };
  }

  async start(
    sessionId: string,
    topic: string,
    agents: AgentConfig[],
    config: DiscussConfig,
    ctx: CallerContext,
  ): Promise<LiveDiscussSession> {
    const input: DiscussCreateInput = {
      topic,
      agents: agents.map((agent) => ({
        name: agent.name,
        persona: agent.persona,
        participation: agent.participation ?? 'required',
      })),
      min_bid_delay_ms: config.min_bid_delay_ms ?? 0,
    };

    const created = unwrapResult(
      decideSessionCreate(
        input,
        sessionId,
        this.projectRoot,
        topic,
        1,
        nowIsoString(),
        undefined,
        readDiscussMaxEpochs(),
        undefined,
        this.buildAgentExecutionConfig(agents),
      ),
      'create session',
    );

    const snapshot = await this.store.append(sessionId, null, created);
    const session = this.attachSession(snapshot);
    this.afterCommit(sessionId, snapshot, created);

    await this.collectBids(sessionId, ctx);
    this.resumeLoop(sessionId, ctx);
    return session;
  }

  async runAgentTurn(
    agentName: string,
    sessionId: string,
    provider: string,
    model: string | undefined,
    prompt: string,
    instruction: string,
    cwd: string,
    ctx: CallerContext,
    timeoutMs?: number,
  ): Promise<{ content: string; nonResumable: boolean }> {
    return this.runPlainTurn(
      agentName,
      sessionId,
      provider,
      model,
      prompt,
      instruction,
      cwd,
      ctx,
      'direct',
      timeoutMs,
    );
  }

  async recoverPersistedSessions(ctx: CallerContext): Promise<void> {
    for (const candidate of this.store.listRecoveryCandidates()) {
      const snapshot = this.store.load(candidate.sessionId);
      if (!snapshot) continue;
      const events = this.readSessionEvents(candidate.sessionId);
      const abortEnded = this.isAbortEnded(events);
      if (abortEnded) continue;
      // Attach only — continueLoop fires when the user re-engages via discuss_participate
      this.attachSession(snapshot, buildWatchEvents(events), abortEnded);
    }
  }

  async submitManualBid(
    sessionId: string,
    agentName: string,
    score: number,
    thought: string,
    ctx: CallerContext,
  ): Promise<BidResult> {
    const session = this.requireLiveSession(sessionId);
    const snapshot = session.snapshot;

    if (snapshot.state.status === 'ended') {
      return {
        action: 'session_ended',
        reason: snapshot.state.end_reason_content ?? undefined,
        content: snapshot.state.end_reason_content ?? undefined,
      };
    }

    const committed = await this.commitDecision(sessionId, (current) =>
      decideBid(
        current.state,
        agentName,
        score,
        thought,
        sessionId,
        this.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        nowIsoString(),
      ));
    if (!isCommitSuccess(committed)) {
      throw new DiscussManagerError(committed.error, committed.detail);
    }

    this.resumeLoop(sessionId, ctx);
    return {
      action: 'listen',
      speaker: null,
      content: 'Bid recorded.',
    };
  }

  async submitManualSpeech(
    sessionId: string,
    agentName: string,
    content: string,
    ctx: CallerContext,
  ): Promise<SpeechResult> {
    const session = this.requireLiveSession(sessionId);
    const snapshot = session.snapshot;

    if (snapshot.state.status === 'ended') {
      return {
        action: 'session_ended',
        reason: snapshot.state.end_reason_content ?? undefined,
        content: snapshot.state.end_reason_content ?? undefined,
      };
    }

    if (snapshot.state.current_speaker !== agentName) {
      return {
        action: 'not_your_turn',
        current_speaker: snapshot.state.current_speaker,
      };
    }

    const committed = await this.commitDecision(sessionId, (current) =>
      decideSpeech(
        current.state,
        agentName,
        content,
        sessionId,
        this.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        nowIsoString(),
      ));
    if (!isCommitSuccess(committed)) {
      throw new DiscussManagerError(committed.error, committed.detail);
    }

    this.resumeLoop(sessionId, ctx);
    return { action: 'speech_recorded' };
  }

  async abortSession(sessionId: string): Promise<void> {
    const session = this.requireLiveSession(sessionId);

    const committed = await this.commitDecision(sessionId, (current) =>
      decideEnd(
        current.state,
        { force: true, reason: ABORT_REASON },
        sessionId,
        this.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        nowIsoString(),
      ));
    if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }

    session.controller.abort();
    this.detachSession(sessionId);
  }

  getWatchState(sessionId: string, cursor?: number): {
    session: string;
    status: string;
    topic: string;
    epoch: number;
    step: number;
    events: WatchEvent[];
    cursor: number;
  } {
    const session = this.sessions.get(sessionId);
    const watchHistory = session
      ? session.watchHistory
      : this.loadEndedWatchHistory(sessionId);
    const snapshot = session
      ? session.snapshot
      : this.loadEndedSnapshot(sessionId);

    if (cursor !== undefined && cursor > watchHistory.length) {
      throw new DiscussManagerError('invalid_cursor', {
        cursor,
        max: watchHistory.length,
      });
    }

    return {
      session: sessionId,
      status: snapshot.state.status,
      topic: snapshot.state.topic,
      epoch: snapshot.state.epoch,
      step: snapshot.state.step,
      events: cursor === undefined ? watchHistory.slice() : watchHistory.slice(cursor),
      cursor: watchHistory.length,
    };
  }

  private loadEndedSnapshot(sessionId: string): PersistedDiscussSnapshot {
    const snapshot = this.store.load(sessionId);
    if (!snapshot) {
      throw new DiscussManagerError('session_not_found', { session: sessionId });
    }
    return snapshot;
  }

  private loadEndedWatchHistory(sessionId: string): WatchEvent[] {
    return buildWatchEvents(this.readSessionEvents(sessionId));
  }

  resumeLoop(sessionId: string, ctx: CallerContext): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.loopState.running || session.controller.signal.aborted) {
      return;
    }

    setTimeout(() => {
      void this.continueLoop(sessionId, ctx).catch((error: unknown) => {
        void this.forceEndAfterLoopFailure(sessionId, error);
      });
    }, 0);
  }

  private attachSession(
    snapshot: PersistedDiscussSnapshot,
    initialWatchHistory: WatchEvent[] = [],
    abortEnded = false,
  ): LiveDiscussSession {
    const existing = this.sessions.get(snapshot.sessionId);
    if (existing) {
      existing.snapshot = snapshot;
      existing.abortEnded = abortEnded;
      return existing;
    }

    const session: LiveDiscussSession = {
      snapshot,
      controller: new AbortController(),
      watchSubscribers: new Set(),
      watchHistory: initialWatchHistory,
      abortEnded,
      loopState: { running: false },
    };
    this.sessions.set(snapshot.sessionId, session);
    return session;
  }

  private requireLiveSession(sessionId: string): LiveDiscussSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new DiscussManagerError('session_not_found', { session: sessionId });
    }
    return session;
  }

  private loadAttachedOrPersistedSnapshot(sessionId: string): PersistedDiscussSnapshot | null {
    return this.sessions.get(sessionId)?.snapshot ?? this.store.load(sessionId);
  }

  private readSessionEvents(sessionId: string): DiscussDomainEvent[] {
    try {
      const sessionDir = this.store.resolveSessionDir(sessionId);
      return readDiscussEventLog(discussEventLogPath(sessionDir)).filter((event) =>
        event.sessionId === sessionId && event.projectRoot === this.projectRoot);
    } catch {
      return [];
    }
  }

  private isAbortEnded(events: DiscussDomainEvent[]): boolean {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.kind !== 'session.ended') {
        continue;
      }
      return event.payload.reason === ABORT_REASON;
    }
    return false;
  }

  private afterCommit(
    sessionId: string,
    snapshot: PersistedDiscussSnapshot,
    events: DiscussDomainEvent[],
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.snapshot = snapshot;
    session.abortEnded ||= this.isAbortEnded(events);
    const watchEvents = buildWatchEvents(events);
    if (watchEvents.length === 0) {
      return;
    }

    session.watchHistory.push(...watchEvents);
    for (const event of watchEvents) {
      for (const subscriber of session.watchSubscribers) {
        subscriber(event);
      }
    }
  }

  private async commitDecision(
    sessionId: string,
    decide: (snapshot: PersistedDiscussSnapshot) => Result<DiscussDomainEvent[]>,
  ): Promise<CommitResult> {
    while (true) {
      const current = this.loadAttachedOrPersistedSnapshot(sessionId);
      if (!current) {
        return { ok: false, error: 'session_not_found', detail: { session: sessionId } };
      }

      const decided = decide(current);
      if (!decided.ok) {
        return { ok: false, error: decided.error, detail: decided.detail };
      }

      if (decided.value.length === 0) {
        return {
          ok: true,
          previous: current,
          snapshot: current,
          events: [],
        };
      }

      try {
        const snapshot = await this.store.append(sessionId, current.lastAppliedSeq, decided.value);
        this.afterCommit(sessionId, snapshot, decided.value);
        return {
          ok: true,
          previous: current,
          snapshot,
          events: decided.value,
        };
      } catch (error: unknown) {
        if (error instanceof DiscussStaleWriteError) {
          const latest = this.store.load(sessionId);
          if (latest) {
            const live = this.sessions.get(sessionId);
            if (live) {
              live.snapshot = latest;
            }
          }
          continue;
        }
        throw error;
      }
    }
  }

  private async appendRuntimeEvents(
    sessionId: string,
    buildEvents: (snapshot: PersistedDiscussSnapshot) => DiscussDomainEvent[],
  ): Promise<PersistedDiscussSnapshot | null> {
    while (true) {
      const current = this.loadAttachedOrPersistedSnapshot(sessionId);
      if (!current) {
        return null;
      }

      const events = buildEvents(current);
      if (events.length === 0) {
        return current;
      }

      try {
        const snapshot = await this.store.append(sessionId, current.lastAppliedSeq, events);
        this.afterCommit(sessionId, snapshot, events);
        return snapshot;
      } catch (error: unknown) {
        if (error instanceof DiscussStaleWriteError) {
          const latest = this.store.load(sessionId);
          if (latest) {
            const live = this.sessions.get(sessionId);
            if (live) {
              live.snapshot = latest;
            }
          }
          continue;
        }
        throw error;
      }
    }
  }

  private buildAgentExecutionConfig(
    agents: AgentConfig[],
  ): Record<string, SessionCreatedAgentExecutionConfig> {
    return Object.fromEntries(
      agents.map((agent) => {
        const isManualObserver =
          (agent.participation ?? 'required') === 'observer'
          && agent.provider === undefined
          && agent.model === undefined;

        if (isManualObserver) {
          return [agent.name, { manual: true }];
        }

        return [agent.name, {
          manual: false,
          provider: agent.provider ?? DEFAULT_DISCUSS_PROVIDER,
          model: agent.model ?? '',
        }];
      }),
    ) as Record<string, SessionCreatedAgentExecutionConfig>;
  }

  private nextAttemptForPurpose(
    run: PersistedDiscussAgentRun | undefined,
    purpose: string,
  ): number {
    if (!run) {
      return 1;
    }
    if (run.currentJobPurpose === purpose && run.currentJobId !== undefined) {
      return run.currentAttempt ?? 1;
    }
    if (isRetryableAttemptOutcome(run.lastAttemptOutcome)) {
      return (run.currentAttempt ?? 0) + 1;
    }
    return 1;
  }

  private currentAgentRun(
    snapshot: PersistedDiscussSnapshot,
    agentName: string,
    provider: string,
    model: string | undefined,
  ): PersistedDiscussAgentRun {
    const existing = snapshot.runtime.agentRuns[agentName];
    if (existing) {
      return existing;
    }

    return {
      provider,
      model: model ?? '',
    };
  }

  private isManualParticipant(snapshot: PersistedDiscussSnapshot, agentName: string): boolean {
    return snapshot.state.agents[agentName]?.participation === 'observer'
      && !(agentName in snapshot.runtime.agentRuns);
  }

  private facilitatorRun(snapshot: PersistedDiscussSnapshot): FacilitatorRun | null {
    for (const [name, agent] of Object.entries(snapshot.state.agents)) {
      if (agent.banned || agent.participation !== 'required') {
        continue;
      }

      const run = snapshot.runtime.agentRuns[name];
      if (run) {
        return {
          agentName: name,
          provider: run.provider,
          model: normalizeModel(run.model),
        };
      }
    }

    return null;
  }

  private async waitForObserverBidWindow(delayMs: number, signal: AbortSignal): Promise<void> {
    if (delayMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private hasPendingAutoBidders(snapshot: PersistedDiscussSnapshot): boolean {
    return Object.entries(snapshot.state.current_bids).some(([agentName, score]) =>
      score === null
      && !snapshot.state.agents[agentName]?.banned
      && !this.isManualParticipant(snapshot, agentName));
  }

  private hasActiveBidWork(snapshot: PersistedDiscussSnapshot): boolean {
    return Object.values(snapshot.runtime.agentRuns).some((run) =>
      run.currentJobId !== undefined && run.currentJobPurpose === PURPOSE_BID);
  }

  private async continueLoop(sessionId: string, ctx: CallerContext): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.loopState.running) {
      return;
    }

    session.loopState.running = true;

    try {
      while (true) {
        const current = this.sessions.get(sessionId);
        if (!current || current.controller.signal.aborted) {
          return;
        }

        const snapshot = current.snapshot;

        if (snapshot.runtime.controlPhase === 'synthesize') {
          if (current.abortEnded) {
            return;
          }
          const beforePhase = snapshot.runtime.controlPhase;
          await this.handleSynthesis(sessionId, ctx);
          const after = this.sessions.get(sessionId);
          if (after?.snapshot.runtime.controlPhase === beforePhase) {
            await this.forceEndAfterLoopFailure(sessionId, new Error('synthesis failed to advance'));
            return;
          }
          continue;
        }

        if (snapshot.runtime.controlPhase === 'evaluate_epoch') {
          await this.handleEpochTransition(sessionId, ctx);
          continue;
        }

        if (snapshot.runtime.controlPhase === 'collect_follow_up') {
          await this.runFollowUpTurns(sessionId, ctx);
          continue;
        }

        if (snapshot.state.status === 'ended') {
          return;
        }

        if (snapshot.state.status === 'speaking') {
          if (!snapshot.state.current_speaker) {
            return;
          }
          if (this.isManualParticipant(snapshot, snapshot.state.current_speaker)) {
            return;
          }
          await this.collectSpeech(sessionId, snapshot.state.current_speaker, ctx);
          continue;
        }

        if (snapshot.runtime.controlPhase === 'observer_wait') {
          await this.waitForObserverBidWindow(snapshot.state.min_bid_delay_ms, current.controller.signal);
          const resolved = await this.commitDecision(sessionId, (latest) =>
            decideBidRoundClose(
              latest.state,
              latest.sessionId,
              this.projectRoot,
              latest.state.topic,
              latest.lastAppliedSeq + 1,
              nowIsoString(),
            ));
          if (!isCommitSuccess(resolved)) {
            if (resolved.error === 'quorum_not_met') {
              await this.collectBids(sessionId, ctx);
              continue;
            }
            if (resolved.error === 'session_not_found') {
              return;
            }
            throw new DiscussManagerError(resolved.error, resolved.detail);
          }
          continue;
        }

        if (snapshot.state.status !== 'bidding') {
          return;
        }

        if (this.hasActiveBidWork(snapshot) || this.hasPendingAutoBidders(snapshot)) {
          await this.collectBids(sessionId, ctx);
          continue;
        }

        const resolved = await this.commitDecision(sessionId, (latest) =>
          decideBidRoundClose(
            latest.state,
            latest.sessionId,
            this.projectRoot,
            latest.state.topic,
            latest.lastAppliedSeq + 1,
            nowIsoString(),
          ));
        if (!isCommitSuccess(resolved)) {
          if (resolved.error === 'quorum_not_met') {
            await this.collectBids(sessionId, ctx);
            continue;
          }
          if (resolved.error === 'session_not_found') {
            return;
          }
          throw new DiscussManagerError(resolved.error, resolved.detail);
        }
      }
    } finally {
      const current = this.sessions.get(sessionId);
      if (current) {
        current.loopState.running = false;
      }
    }
  }

  private async executeAgentAttempt(
    agentName: string,
    sessionId: string,
    provider: string,
    model: string | undefined,
    prompt: string,
    instruction: string,
    cwd: string,
    ctx: CallerContext,
    purpose: string,
    timeoutMs?: number,
  ): Promise<AttemptResult> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot) {
      return {
        ok: false,
        consumedAttempt: false,
        message: `Discuss session not found: ${sessionId}`,
      };
    }

    let activeRun = this.currentAgentRun(snapshot, agentName, provider, model);
    let attempt = this.nextAttemptForPurpose(snapshot.runtime.agentRuns[agentName], purpose);
    let activeJobId =
      activeRun.currentJobPurpose === purpose
        ? activeRun.currentJobId
        : undefined;

    while (activeJobId) {
      const status = readStatusRecord(activeJobId);
      if (status === null) {
        await this.recordJobFinished(sessionId, agentName, purpose, activeJobId, attempt, 'recovery_missing');
      } else if (status.phase === 'completed') {
        return {
          ok: true,
          attempt,
          jobId: activeJobId,
          content: status.result?.content ?? '',
          nonResumable: status.result?.nonResumable ?? false,
        };
      } else if (!isLivePhase(status.phase)) {
        await this.recordJobFinished(sessionId, agentName, purpose, activeJobId, attempt, 'recovery_failed');
      } else {
        try {
          const result = await this.service.waitStreamOnce(activeJobId, timeoutMs);
          return {
            ok: true,
            attempt,
            jobId: activeJobId,
            content: result.content,
            nonResumable: result.nonResumable,
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordJobFinished(sessionId, agentName, purpose, activeJobId, attempt, 'execution_error');
          return {
            ok: false,
            attempt,
            consumedAttempt: true,
            message,
          };
        }
      }

      const refreshed = this.loadAttachedOrPersistedSnapshot(sessionId);
      if (!refreshed) {
        return {
          ok: false,
          attempt,
          consumedAttempt: true,
          message: `Discuss session not found: ${sessionId}`,
        };
      }

      activeRun = this.currentAgentRun(refreshed, agentName, provider, model);
      attempt = this.nextAttemptForPurpose(refreshed.runtime.agentRuns[agentName], purpose);
      activeJobId =
        activeRun.currentJobPurpose === purpose
          ? activeRun.currentJobId
          : undefined;
    }

    const executionSessionId = activeRun.executionSessionId;
    let launch;
    if (executionSessionId === undefined) {
      launch = await this.service.start(provider, {
        prompt,
        model,
        pool: 'discuss',
        cwd,
        bypassPermissions: true,
        instruction: {
          channel: 'system',
          content: instruction,
        },
      }, ctx);
    } else {
      launch = await this.service.resume(provider, {
        sessionId: executionSessionId,
        prompt: `${instruction}\n\n---\n\n${prompt}`,
        model,
        pool: 'discuss',
        cwd,
        bypassPermissions: true,
      }, ctx);
    }

    if (launch.status === 'rejected') {
      return {
        ok: false,
        consumedAttempt: false,
        message: launch.message,
      };
    }

    if (executionSessionId === undefined) {
      await this.appendRuntimeEvents(sessionId, (current) => {
        const latestRun = current.runtime.agentRuns[agentName];
        if (latestRun?.executionSessionId === launch.session) {
          return [];
        }
        return [
          makeEvent(
            current.sessionId,
            this.projectRoot,
            current.state.topic,
            current.lastAppliedSeq + 1,
            'agent.run.bound',
            nowIsoString(),
            {
              agent: agentName,
              executionSessionId: launch.session,
            },
          ),
        ];
      });
    }

    await this.appendRuntimeEvents(sessionId, (current) => {
      const latestRun = current.runtime.agentRuns[agentName];
      if (latestRun?.currentJobId === launch.job
        && latestRun.currentJobPurpose === purpose
        && latestRun.currentAttempt === attempt) {
        return [];
      }

      return [
        makeEvent(
          current.sessionId,
          this.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'agent.job.started',
          nowIsoString(),
          {
            agent: agentName,
            jobId: launch.job,
            purpose,
            attempt,
          },
        ),
      ];
    });

    try {
      const result = await this.service.waitStreamOnce(launch.job, timeoutMs);
      return {
        ok: true,
        attempt,
        jobId: launch.job,
        content: result.content,
        nonResumable: result.nonResumable,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordJobFinished(sessionId, agentName, purpose, launch.job, attempt, 'execution_error');
      return {
        ok: false,
        attempt,
        consumedAttempt: true,
        message,
      };
    }
  }

  private async recordJobFinished(
    sessionId: string,
    agentName: string,
    purpose: string,
    jobId: string,
    attempt: number,
    outcome: string,
  ): Promise<void> {
    await this.appendRuntimeEvents(sessionId, (current) => {
      const run = current.runtime.agentRuns[agentName];
      if (!run || run.currentJobPurpose !== purpose || run.currentAttempt !== attempt) {
        return [];
      }
      if (run.currentJobId !== jobId) {
        return [];
      }

      return [
        makeEvent(
          current.sessionId,
          this.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'agent.job.finished',
          nowIsoString(),
          {
            agent: agentName,
            jobId,
            outcome,
            attempt,
          },
        ),
      ];
    });
  }

  private async runPlainTurn(
    agentName: string,
    sessionId: string,
    provider: string,
    model: string | undefined,
    prompt: string,
    instruction: string,
    cwd: string,
    ctx: CallerContext,
    purpose: string,
    timeoutMs?: number,
  ): Promise<{ content: string; nonResumable: boolean }> {
    const attempt = await this.executeAgentAttempt(
      agentName,
      sessionId,
      provider,
      model,
      prompt,
      instruction,
      cwd,
      ctx,
      purpose,
      timeoutMs,
    );
    if (!isAttemptSuccess(attempt)) {
      throw new Error(attempt.message);
    }

    await this.recordJobFinished(
      sessionId,
      agentName,
      purpose,
      attempt.jobId,
      attempt.attempt,
      attempt.nonResumable ? 'non_resumable' : 'completed',
    );

    return {
      content: attempt.content,
      nonResumable: attempt.nonResumable,
    };
  }

  private async runFacilitatorTurn(
    sessionId: string,
    prompt: string,
    instruction: string,
    ctx: CallerContext,
    timeoutMs: number,
    purpose: string,
  ): Promise<{ content: string; nonResumable: boolean }> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot) {
      throw new Error(`Discuss session not found: ${sessionId}`);
    }

    const facilitatorRun = this.facilitatorRun(snapshot);
    if (!facilitatorRun) {
      throw new Error('No facilitator agent is available');
    }

    return this.runPlainTurn(
      facilitatorRun.agentName,
      sessionId,
      facilitatorRun.provider,
      facilitatorRun.model,
      prompt,
      instruction,
      this.projectRoot,
      ctx,
      purpose,
      timeoutMs,
    );
  }

  private resolveMustAnswerTarget(state: DiscussState, rawTarget: string): string | null {
    const target = rawTarget.trim();
    if (target.length === 0) {
      return null;
    }

    const resolved = resolveAgentName(state.agents, target);
    if (resolved !== null) {
      return resolved;
    }

    for (const [name, agent] of Object.entries(state.agents)) {
      if (agent.display_name === target) {
        return name;
      }
    }

    return null;
  }

  private normalizeMustAnswerItems(
    state: DiscussState,
    items: z.infer<typeof EpochEvaluationSchema>['must_answer'],
  ): MustAnswerItem[] {
    const normalized: MustAnswerItem[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      const target = this.resolveMustAnswerTarget(state, item.to);
      const question = item.question.trim();
      if (target === null || question.length === 0 || state.agents[target]?.banned) {
        continue;
      }

      const key = `${target}${MUST_ANSWER_SEPARATOR}${question}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({ to: target, question });
    }

    return normalized;
  }

  private parseEpochEvaluation(content: string, state: DiscussState): EpochEvaluation {
    try {
      const parsed = JSON.parse(stripFencedCodeBlock(content)) as unknown;
      const evaluation = EpochEvaluationSchema.parse(parsed);
      return {
        convergence: evaluation.convergence,
        summary: evaluation.summary,
        mustAnswer: this.normalizeMustAnswerItems(state, evaluation.must_answer),
      };
    } catch {
      return {
        convergence: 0,
        summary: '',
        mustAnswer: [],
      };
    }
  }

  private mustAnswerText(snapshot: PersistedDiscussSnapshot, agentName: string): string | null {
    const questions = snapshot.runtime.carryForwardMustAnswer
      .map((item) => parseMustAnswerItem(item))
      .filter((item): item is MustAnswerItem => item !== null && item.to === agentName)
      .map((item) => item.question.trim())
      .filter((question) => question.length > 0);

    if (questions.length === 0) {
      return null;
    }

    if (questions.length === 1) {
      return questions[0] ?? null;
    }

    return questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
  }

  private buildFollowUpPrompt(state: DiscussState, agentName: string, question: string): string {
    const agent = state.agents[agentName];
    const speakerLabel = agent?.display_name ?? agentName;
    return [
      `Discussion topic:\n${state.topic}`,
      `You are ${speakerLabel} (${agentName}).`,
      'Review the transcript and answer the moderator follow-up.',
      renderTranscriptText(state),
      `Follow-up question:\n${question}`,
    ].join('\n\n');
  }

  private async evaluateEpoch(sessionId: string, ctx: CallerContext): Promise<EpochEvaluation> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot) {
      return {
        convergence: 0,
        summary: '',
        mustAnswer: [],
      };
    }

    const prompt = [
      'Review the discussion transcript and provide an evaluation:',
      '',
      renderTranscriptText(snapshot.state),
      '',
      'Respond with ONLY valid JSON (no code fences):',
      '{"convergence": 0-10, "summary": "...", "must_answer": [{"to": "agent-name", "question": "..."}]}',
      '',
      'convergence: 0=highly divergent, 10=fully converged',
      'summary: brief synthesis of key positions and progress',
      'must_answer: list of critical questions that need answers before convergence',
    ].join('\n');

    try {
      const result = await this.runFacilitatorTurn(
        sessionId,
        prompt,
        'You are evaluating convergence in a discussion. Return only valid JSON that matches the requested schema.',
        ctx,
        EPOCH_EVAL_TIMEOUT_MS,
        PURPOSE_EPOCH_EVALUATION,
      );
      return this.parseEpochEvaluation(result.content, snapshot.state);
    } catch {
      return {
        convergence: 0,
        summary: '',
        mustAnswer: [],
      };
    }
  }

  private async handleEpochTransition(sessionId: string, ctx: CallerContext): Promise<void> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot || snapshot.runtime.controlPhase !== 'evaluate_epoch') {
      return;
    }

    const evaluation = await this.evaluateEpoch(sessionId, ctx);
    const committed = await this.commitDecision(sessionId, (current) => {
      if (current.runtime.controlPhase !== 'evaluate_epoch' || current.state.status !== 'bidding') {
        return { ok: true, value: [] };
      }

      const nextSeq = current.lastAppliedSeq + 1;
      const ts = nowIsoString();
      if (evaluation.convergence < CONVERGENCE_THRESHOLD) {
        const summaryEvents = unwrapResult(
          decideEpochSummary(
            current.state,
            evaluation.summary,
            sessionId,
            this.projectRoot,
            current.state.topic,
            nextSeq,
            ts,
          ),
          'record epoch summary',
        );

        return {
          ok: true,
          value: [
            ...summaryEvents,
            makeEvent(
              sessionId,
              this.projectRoot,
              current.state.topic,
              nextSeq + summaryEvents.length,
              'must_answer.carry_forward.set',
              ts,
              {
                items: evaluation.mustAnswer.map(encodeCarryForward),
              },
            ),
          ],
        };
      }

      if (evaluation.mustAnswer.length > 0) {
        return {
          ok: true,
          value: [
            makeEvent(
              sessionId,
              this.projectRoot,
              current.state.topic,
              nextSeq,
              'follow_up.queue.set',
              ts,
              {
                queue: evaluation.mustAnswer.map((item) => ({
                  agent: item.to,
                  question: item.question,
                })),
              },
            ),
          ],
        };
      }

      return decideEnd(
        current.state,
        { force: true, reason: 'Discussion converged.' },
        sessionId,
        this.projectRoot,
        current.state.topic,
        nextSeq,
        ts,
      );
    });
    if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
  }

  private buildBidBatch(
    snapshot: PersistedDiscussSnapshot,
    outcomes: BidOutcome[],
  ): DiscussDomainEvent[] {
    if (snapshot.state.status !== 'bidding') {
      return [];
    }

    let working = snapshot;
    const events: DiscussDomainEvent[] = [];
    let nextSeq = snapshot.lastAppliedSeq + 1;
    const expelAgents: string[] = [];
    const answeredAgents = new Set<string>();

    for (const outcome of outcomes) {
      const bidDecision = decideBid(
        working.state,
        outcome.agentName,
        outcome.score,
        outcome.thought,
        snapshot.sessionId,
        snapshot.projectRoot,
        snapshot.state.topic,
        nextSeq,
        nowIsoString(),
      );

      if (!bidDecision.ok) {
        if (bidDecision.error === 'already_bid' || bidDecision.error === 'agent_not_found') {
          continue;
        }
        return [];
      }

      events.push(...bidDecision.value);
      working = applyEventsLocally(working, bidDecision.value);
      nextSeq += bidDecision.value.length;

      if (outcome.shouldExpel && !working.state.agents[outcome.agentName]?.banned) {
        expelAgents.push(outcome.agentName);
      }
      if (outcome.answeredCarryForward) {
        answeredAgents.add(outcome.agentName);
      }
    }

    if (expelAgents.length > 0) {
      const expelEvents = unwrapResult(
        decideExpel(
          working.state,
          expelAgents,
          snapshot.sessionId,
          snapshot.projectRoot,
          snapshot.state.topic,
          nextSeq,
          nowIsoString(),
        ),
        `expel agents ${expelAgents.join(', ')}`,
      );
      events.push(...expelEvents);
      working = applyEventsLocally(working, expelEvents);
      nextSeq += expelEvents.length;
    }

    if (answeredAgents.size > 0 && snapshot.runtime.carryForwardMustAnswer.length > 0) {
      const remaining = snapshot.runtime.carryForwardMustAnswer.filter((item) => {
        const decoded = parseMustAnswerItem(item);
        return decoded === null || !answeredAgents.has(decoded.to);
      });

      if (remaining.length !== snapshot.runtime.carryForwardMustAnswer.length) {
        const clearEvent = makeEvent(
          snapshot.sessionId,
          snapshot.projectRoot,
          snapshot.state.topic,
          nextSeq,
          'must_answer.carry_forward.set',
          nowIsoString(),
          { items: remaining },
        );
        events.push(clearEvent);
        working = reduceDiscussEvent(working, clearEvent);
        nextSeq += 1;
      }
    }

    const hadExistingBid = Object.values(snapshot.state.current_bids).some((value) => value !== null);
    const allPendingAgentsFailed =
      outcomes.length > 0 && outcomes.every((outcome) => outcome.executionFailure);

    if (!hadExistingBid && allPendingAgentsFailed) {
      const endEvents = unwrapResult(
        decideEnd(
          working.state,
          { endReason: 'no_participants' },
          snapshot.sessionId,
          snapshot.projectRoot,
          snapshot.state.topic,
          nextSeq,
          nowIsoString(),
        ),
        'end session after bid failures',
      );
      events.push(...endEvents);
    }

    return events;
  }

  private async collectBidOutcome(
    sessionId: string,
    snapshot: PersistedDiscussSnapshot,
    agentName: string,
    ctx: CallerContext,
  ): Promise<BidOutcome> {
    const run = this.currentAgentRun(
      snapshot,
      agentName,
      DEFAULT_DISCUSS_PROVIDER,
      undefined,
    );
    const priorSpeech = lastSpeech(snapshot.state.transcript);
    const priorSpeechForAgent =
      priorSpeech !== null && priorSpeech.speaker !== agentName ? priorSpeech : null;
    const mustAnswer = this.mustAnswerText(snapshot, agentName);
    const basePrompt = buildBidPrompt({
      selfName: agentName,
      state: snapshot.state,
      priorSpeech: priorSpeechForAgent,
      mustAnswer,
    });
    const instruction = run.executionSessionId === undefined
      ? buildFirstTurnInstruction({
        selfName: agentName,
        state: snapshot.state,
        priorSpeech: priorSpeechForAgent,
        mustAnswer,
      })
      : CONTINUE_TURN_INSTRUCTION;

    const latestRun = this.loadAttachedOrPersistedSnapshot(sessionId)?.runtime.agentRuns[agentName] ?? run;
    if (
      latestRun.currentJobId === undefined
      && latestRun.lastAttemptOutcome === 'retryable_parse_error'
      && (latestRun.currentAttempt ?? 0) >= MAX_BID_ATTEMPTS
    ) {
      return {
        agentName,
        score: 0,
        thought: '',
        executionFailure: false,
        shouldExpel: false,
        answeredCarryForward: false,
      };
    }

    let prompt = basePrompt;

    while (true) {
      const attempt = await this.executeAgentAttempt(
        agentName,
        sessionId,
        run.provider,
        normalizeModel(run.model),
        prompt,
        instruction,
        this.projectRoot,
        ctx,
        PURPOSE_BID,
        BID_ATTEMPT_TIMEOUT_MS,
      );

      if (!isAttemptSuccess(attempt)) {
        return {
          agentName,
          score: 0,
          thought: '',
          executionFailure: true,
          shouldExpel: this.loadAttachedOrPersistedSnapshot(sessionId)?.state.agents[agentName]?.participation === 'required',
          answeredCarryForward: false,
        };
      }

      if (attempt.nonResumable) {
        await this.recordJobFinished(sessionId, agentName, PURPOSE_BID, attempt.jobId, attempt.attempt, 'non_resumable');
        return {
          agentName,
          score: 0,
          thought: '',
          executionFailure: true,
          shouldExpel: snapshot.state.agents[agentName]?.participation === 'required',
          answeredCarryForward: false,
        };
      }

      try {
        const bid = parseBidResponse(attempt.content);
        await this.recordJobFinished(sessionId, agentName, PURPOSE_BID, attempt.jobId, attempt.attempt, 'completed');
        return {
          agentName,
          score: bid.score,
          thought: bid.thought,
          executionFailure: false,
          shouldExpel: false,
          answeredCarryForward: mustAnswer !== null,
        };
      } catch (error: unknown) {
        await this.recordJobFinished(sessionId, agentName, PURPOSE_BID, attempt.jobId, attempt.attempt, 'retryable_parse_error');

        if (attempt.attempt >= MAX_BID_ATTEMPTS) {
          return {
            agentName,
            score: 0,
            thought: '',
            executionFailure: false,
            shouldExpel: false,
            answeredCarryForward: false,
          };
        }

        const failure = error instanceof Error ? error.message : String(error);
        prompt = buildBidRetryPrompt(basePrompt, attempt.content, failure);
      }
    }
  }

  private async collectBids(sessionId: string, ctx: CallerContext): Promise<void> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot || snapshot.state.status !== 'bidding') {
      return;
    }

    const bidders = Object.entries(snapshot.state.current_bids)
      .filter(([agentName, score]) =>
        score === null
        && !snapshot.state.agents[agentName]?.banned
        && !this.isManualParticipant(snapshot, agentName),
      )
      .map(([agentName]) => agentName);

    if (bidders.length === 0) {
      return;
    }

    const outcomes = await Promise.all(
      bidders.map((agentName) => this.collectBidOutcome(sessionId, snapshot, agentName, ctx)),
    );

    const committed = await this.commitDecision(sessionId, (current) => ({
      ok: true,
      value: this.buildBidBatch(current, outcomes),
    }));
    if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
  }

  private async collectSpeech(
    sessionId: string,
    winnerName: string,
    ctx: CallerContext,
  ): Promise<void> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot || snapshot.state.status !== 'speaking' || snapshot.state.current_speaker !== winnerName) {
      return;
    }

    const agentRun = this.currentAgentRun(
      snapshot,
      winnerName,
      DEFAULT_DISCUSS_PROVIDER,
      undefined,
    );
    const prompt = buildSpeechPrompt({
      selfName: winnerName,
      state: snapshot.state,
      priorSpeech: null,
    });

    const attempt = await this.executeAgentAttempt(
      winnerName,
      sessionId,
      agentRun.provider,
      normalizeModel(agentRun.model),
      prompt,
      CONTINUE_TURN_INSTRUCTION,
      this.projectRoot,
      ctx,
      PURPOSE_SPEECH,
      SPEECH_TIMEOUT_MS,
    );

    if (!isAttemptSuccess(attempt) || attempt.nonResumable) {
      if (isAttemptSuccess(attempt)) {
        await this.recordJobFinished(sessionId, winnerName, PURPOSE_SPEECH, attempt.jobId, attempt.attempt, 'non_resumable');
      }
      const committed = await this.commitDecision(sessionId, (current) =>
        decideSpeechTimeout(
          current.state,
          sessionId,
          this.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          nowIsoString(),
        ));
      if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
        throw new DiscussManagerError(committed.error, committed.detail);
      }
      return;
    }

    await this.recordJobFinished(sessionId, winnerName, PURPOSE_SPEECH, attempt.jobId, attempt.attempt, 'completed');
    const committed = await this.commitDecision(sessionId, (current) =>
      decideSpeech(
        current.state,
        winnerName,
        attempt.content,
        sessionId,
        this.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        nowIsoString(),
      ));
    if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
  }

  private async collectFollowUpAnswer(
    sessionId: string,
    item: FollowUpQueueItem,
    ctx: CallerContext,
  ): Promise<string> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot) {
      return '';
    }

    const run = this.currentAgentRun(
      snapshot,
      item.agent,
      DEFAULT_DISCUSS_PROVIDER,
      undefined,
    );
    const latestRun = this.loadAttachedOrPersistedSnapshot(sessionId)?.runtime.agentRuns[item.agent] ?? run;
    if (
      latestRun.currentJobId === undefined
      && latestRun.lastAttemptOutcome === 'retryable_parse_error'
      && (latestRun.currentAttempt ?? 0) >= MAX_FOLLOW_UP_ATTEMPTS
    ) {
      return '';
    }

    const basePrompt = this.buildFollowUpPrompt(snapshot.state, item.agent, item.question);
    let prompt = basePrompt;

    while (true) {
      const attempt = await this.executeAgentAttempt(
        item.agent,
        sessionId,
        run.provider,
        normalizeModel(run.model),
        prompt,
        FOLLOW_UP_TURN_INSTRUCTION,
        this.projectRoot,
        ctx,
        PURPOSE_FOLLOW_UP,
        SPEECH_TIMEOUT_MS,
      );

      if (!isAttemptSuccess(attempt)) {
        return attempt.message;
      }

      if (attempt.nonResumable) {
        await this.recordJobFinished(sessionId, item.agent, PURPOSE_FOLLOW_UP, attempt.jobId, attempt.attempt, 'non_resumable');
        return '';
      }

      const answer = normalizeFollowUpAnswer(attempt.content);
      if (answer.length > 0) {
        await this.recordJobFinished(sessionId, item.agent, PURPOSE_FOLLOW_UP, attempt.jobId, attempt.attempt, 'completed');
        return answer;
      }

      await this.recordJobFinished(sessionId, item.agent, PURPOSE_FOLLOW_UP, attempt.jobId, attempt.attempt, 'retryable_parse_error');
      if (attempt.attempt >= MAX_FOLLOW_UP_ATTEMPTS) {
        return '';
      }
      prompt = buildFollowUpRetryPrompt(basePrompt, attempt.content, 'Empty answer');
    }
  }

  private async runFollowUpTurns(sessionId: string, ctx: CallerContext): Promise<void> {
    while (true) {
      const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
      if (!snapshot || snapshot.runtime.controlPhase !== 'collect_follow_up') {
        return;
      }

      const item = snapshot.runtime.followUpQueue[0];
      if (!item) {
        const ended = await this.commitDecision(sessionId, (current) =>
          decideEnd(
            current.state,
            { force: true, reason: 'Discussion converged after follow-ups.' },
            sessionId,
            this.projectRoot,
            current.state.topic,
            current.lastAppliedSeq + 1,
            nowIsoString(),
          ));
        if (!isCommitSuccess(ended) && ended.error !== 'session_not_found') {
          throw new DiscussManagerError(ended.error, ended.detail);
        }
        return;
      }

      const answer = await this.collectFollowUpAnswer(sessionId, item, ctx);
      const committed = await this.commitDecision(sessionId, (current) => ({
        ok: true,
        value: [
          makeEvent(
            sessionId,
            this.projectRoot,
            current.state.topic,
            current.lastAppliedSeq + 1,
            'follow_up.answered',
            nowIsoString(),
            {
              agent: item.agent,
              question: item.question,
              answer,
            },
          ),
        ],
      }));
      if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
        throw new DiscussManagerError(committed.error, committed.detail);
      }
    }
  }

  private async handleSynthesis(sessionId: string, ctx: CallerContext): Promise<void> {
    const snapshot = this.loadAttachedOrPersistedSnapshot(sessionId);
    if (!snapshot || snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'synthesize') {
      return;
    }
    if (this.sessions.get(sessionId)?.abortEnded ?? false) {
      return;
    }

    const prompt = [
      'Write the final synthesis for this discussion.',
      '',
      renderTranscriptText(snapshot.state),
      '',
      snapshot.state.transcript.some((entry) => entry.type === 'follow_up')
        ? 'The transcript includes moderator follow-up answers. Incorporate them into the final synthesis.'
        : null,
      'Respond with the final synthesis text only. Do not use markdown or code fences.',
    ]
      .filter((section): section is string => section !== null)
      .join('\n');

    try {
      const result = await this.runFacilitatorTurn(
        sessionId,
        prompt,
        'You are writing the final synthesis for a discussion. Return only the synthesis text.',
        ctx,
        SPEECH_TIMEOUT_MS,
        PURPOSE_SYNTHESIS,
      );

      if (result.nonResumable) {
        return;
      }

      const committed = await this.commitDecision(sessionId, (current) =>
        decideSynthesis(
          current.state,
          result.content,
          sessionId,
          this.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          nowIsoString(),
        ));
      if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
        throw new DiscussManagerError(committed.error, committed.detail);
      }
      this.detachSession(sessionId);
    } catch {
      return;
    }
  }

  private async forceEndAfterLoopFailure(sessionId: string, error: unknown): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.snapshot.state.status === 'ended') {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    const committed = await this.commitDecision(sessionId, (current) =>
      decideEnd(
        current.state,
        { force: true, reason: detail },
        sessionId,
        this.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        nowIsoString(),
      ));
    if (!isCommitSuccess(committed) && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
  }
}

export class DiscussManagerRegistry {
  private readonly managers = new Map<string, DiscussManager>();

  getOrCreate(
    projectRoot: string,
    service: ExecutionService,
    store: DiscussSessionStore = new DiscussSessionStore(projectRoot),
  ): DiscussManager {
    const existing = this.managers.get(projectRoot);
    if (existing) {
      return existing;
    }

    const manager = new DiscussManager(
      projectRoot,
      service,
      store,
    );
    this.managers.set(projectRoot, manager);
    return manager;
  }

  get(projectRoot: string): DiscussManager | undefined {
    return this.managers.get(projectRoot);
  }

  listLiveSessions(): Array<{ projectRoot: string; sessionId: string; session: LiveDiscussSession }> {
    const sessions: Array<{ projectRoot: string; sessionId: string; session: LiveDiscussSession }> = [];
    for (const [projectRoot, manager] of this.managers.entries()) {
      for (const [sessionId, session] of manager.listSessions()) {
        sessions.push({ projectRoot, sessionId, session });
      }
    }
    return sessions;
  }

  hasLiveSessions(): boolean {
    for (const manager of this.managers.values()) {
      if (manager.hasLiveSessions()) {
        return true;
      }
    }
    return false;
  }
}
