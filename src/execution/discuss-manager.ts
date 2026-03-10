import { z } from 'zod';

import {
  applyBid,
  applyEnd,
  applyEpochSummary,
  applyExpel,
  applySpeech,
  applySpeechTimeout,
  applySynthesis,
  DEFAULT_MAX_EPOCHS,
  initSession,
  resolveWinner,
  resolveAgentName,
  startBidding,
} from '../discuss/state-machine.js';
import type {
  AgentState,
  DiscussState,
  EndReason,
  TranscriptEntry,
} from '../discuss/types.js';
import { renderEntries, renderHeader } from '../discuss/transcript.js';
import { nowIsoString } from '../discuss/util/time.js';
import type { CallerContext } from './request-context.js';
import { buildBidPrompt, buildFirstTurnInstruction, buildSpeechPrompt } from './discuss-prompts.js';
import type { ExecutionService } from './service.js';

export type AgentRun = {
  provider: string;
  model?: string;
  sessionId?: string;
  currentJobId?: string;
};

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

export type DiscussSession = {
  state: DiscussState & {
    agents: Record<string, AgentState>;
    transcript: TranscriptEntry[];
  };
  agentRuns: Map<string, AgentRun>;
  controller: AbortController;
  watchLog: WatchEvent[];
  watchSubscribers: Set<(event: WatchEvent) => void>;
  mustAnswerQueue: MustAnswerItem[];
  followUpEntries: FollowUpEntry[];
};

const DEFAULT_DISCUSS_PROVIDER = 'codex';
const DEFAULT_FACILITATOR_PROVIDER = 'claude';
const BID_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000;
const SPEECH_TIMEOUT_MS = 5 * 60 * 1000;
const CONVERGENCE_THRESHOLD = 7;
const EPOCH_EVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BID_ATTEMPTS = 3;
const CONTINUE_TURN_INSTRUCTION =
  'You are participating in a backend-managed multi-agent discussion. Follow the prompt exactly and return only the requested format.';
const FOLLOW_UP_TURN_INSTRUCTION =
  'You are answering a moderator follow-up in an ongoing discussion. Respond with the answer text only. Do not use markdown or code fences.';
const EVALUATOR_AGENT_NAME = '__evaluator__';
const SYNTHESIS_AGENT_NAME = '__synthesis__';
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

type BidOutcome = {
  agentName: string;
  score: number;
  thought: string;
  executionFailure: boolean;
  shouldExpel: boolean;
};

type DiscussionEndReason = Exclude<EndReason, 'already_ended' | 'no_participants'>;
type MustAnswerItem = {
  to: string;
  question: string;
};
type FollowUpEntry = Extract<TranscriptEntry, { type: 'follow_up' }>;
type EpochEvaluation = {
  convergence: number;
  summary: string;
  mustAnswer: MustAnswerItem[];
};

function unwrapResult<T>(
  result: { ok: true; value: T } | { ok: false; error: string; detail?: Record<string, unknown> },
  action: string,
): T {
  if (result.ok) {
    return result.value;
  }

  const detail = result.detail === undefined ? '' : ` ${JSON.stringify(result.detail)}`;
  throw new Error(`Discuss manager failed to ${action}: ${result.error}${detail}`);
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

function parseBidResponse(content: string): { score: number; thought: string } {
  const parsed = JSON.parse(stripFencedCodeBlock(content));
  return BidSchema.parse(parsed);
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

export class DiscussManager {
  private readonly sessions = new Map<string, DiscussSession>();
  private readonly projectRoot: string;
  private readonly service: ExecutionService;

  constructor(projectRoot: string, service: ExecutionService) {
    this.projectRoot = projectRoot;
    this.service = service;
  }

  hasLiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (!session.controller.signal.aborted && session.state.status !== 'ended') return true;
    }
    return false;
  }

  getSession(sessionId: string): DiscussSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Array<[string, DiscussSession]> {
    return [...this.sessions.entries()];
  }

  createSession(sessionId: string, state: DiscussState): DiscussSession {
    const session: DiscussSession = {
      state,
      agentRuns: new Map<string, AgentRun>(),
      controller: new AbortController(),
      watchLog: [],
      watchSubscribers: new Set<(event: WatchEvent) => void>(),
      mustAnswerQueue: [],
      followUpEntries: [],
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async start(
    sessionId: string,
    topic: string,
    agents: AgentConfig[],
    config: DiscussConfig,
    ctx: CallerContext,
  ): Promise<DiscussSession> {
    let state = initSession({
      topic,
      agents: agents.map((agent) => ({
        name: agent.name,
        persona: agent.persona,
        participation: agent.participation ?? 'required',
        })),
      min_bid_delay_ms: config.min_bid_delay_ms ?? 0,
    }, nowIsoString(), undefined, readDiscussMaxEpochs());

    state = { ...state, session_id: sessionId };
    state = unwrapResult(startBidding(state, nowIsoString()), 'start bidding');

    const session = this.createSession(sessionId, state);
    for (const agent of agents) {
      const isManualObserver =
        (agent.participation ?? 'required') === 'observer'
        && agent.provider === undefined
        && agent.model === undefined;
      if (isManualObserver) {
        continue;
      }
      session.agentRuns.set(agent.name, {
        provider: agent.provider ?? DEFAULT_DISCUSS_PROVIDER,
        model: agent.model,
      });
    }

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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Discuss session not found: ${sessionId}`);
    }

    const existingRun = session.agentRuns.get(agentName);
    const agentRun = existingRun ?? { provider, model };
    if (!existingRun) {
      session.agentRuns.set(agentName, agentRun);
    }
    agentRun.provider = provider;
    agentRun.model = model;

    const isFirstTurn = agentRun.sessionId === undefined;
    let launch;
    if (agentRun.sessionId === undefined) {
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
        sessionId: agentRun.sessionId,
        prompt: `${instruction}\n\n---\n\n${prompt}`,
        model,
        pool: 'discuss',
        cwd,
        bypassPermissions: true,
      }, ctx);
    }

    if (launch.status === 'rejected') {
      throw new Error(launch.message);
    }

    agentRun.currentJobId = launch.job;

    try {
      if (isFirstTurn) {
        agentRun.sessionId = launch.session;
      }

      if (timeoutMs !== undefined) {
        return await this.service.waitStreamOnce(launch.job, timeoutMs);
      }

      for await (const event of this.service.waitStream({ jobIds: [launch.job] })) {
        if (event.type === 'timeout') {
          throw new Error('Job timed out waiting for terminal result');
        }
        if (event.type !== 'terminal' || event.completedJobId !== launch.job) {
          continue;
        }
        if (isFirstTurn) {
          agentRun.sessionId = event.sessionId;
        }
        return {
          content: event.result.content,
          nonResumable: event.result.nonResumable ?? false,
        };
      }
    } finally {
      agentRun.currentJobId = undefined;
    }

    throw new Error(`Job ${launch.job} ended without a terminal result`);
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  subscribe(sessionId: string, callback: (event: WatchEvent) => void): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) return () => {};
    session.watchSubscribers.add(callback);
    return () => {
      session.watchSubscribers.delete(callback);
    };
  }

  emitWatch(sessionId: string, event: WatchEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.watchLog.push(event);
    for (const subscriber of session.watchSubscribers) {
      subscriber(event);
    }
  }

  resumeLoop(sessionId: string, ctx: CallerContext): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.state.status === 'ended' || session.controller.signal.aborted) {
      return;
    }

    setTimeout(() => {
      void this.continueLoop(sessionId, ctx).catch((error: unknown) => {
        void this.forceEndAfterLoopFailure(sessionId, error);
      });
    }, 0);
  }

  private ensureAgentRun(session: DiscussSession, agentName: string): AgentRun {
    const existing = session.agentRuns.get(agentName);
    if (existing) {
      return existing;
    }

    const created: AgentRun = { provider: DEFAULT_DISCUSS_PROVIDER };
    session.agentRuns.set(agentName, created);
    return created;
  }

  private isManualParticipant(session: DiscussSession, agentName: string): boolean {
    return session.state.agents[agentName]?.participation === 'observer'
      && !session.agentRuns.has(agentName);
  }

  private facilitatorRun(session: DiscussSession): AgentRun {
    for (const [name, agent] of Object.entries(session.state.agents)) {
      if (agent.banned || agent.participation !== 'required') {
        continue;
      }
      const agentRun = session.agentRuns.get(name);
      return {
        provider: agentRun?.provider ?? DEFAULT_FACILITATOR_PROVIDER,
        model: agentRun?.model,
      };
    }

    return { provider: DEFAULT_FACILITATOR_PROVIDER };
  }

  private async runFacilitatorTurn(
    agentName: string,
    sessionId: string,
    prompt: string,
    instruction: string,
    ctx: CallerContext,
    timeoutMs: number,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Discuss session not found: ${sessionId}`);
    }

    const facilitatorRun = this.facilitatorRun(session);
    try {
      const result = await this.runAgentTurn(
        agentName,
        sessionId,
        facilitatorRun.provider,
        facilitatorRun.model,
        prompt,
        instruction,
        this.projectRoot,
        ctx,
        timeoutMs,
      );
      return result.content;
    } finally {
      this.sessions.get(sessionId)?.agentRuns.delete(agentName);
    }
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

      const key = `${target}\u0000${question}`;
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

  private async evaluateEpoch(sessionId: string, ctx: CallerContext): Promise<EpochEvaluation> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        convergence: 0,
        summary: '',
        mustAnswer: [],
      };
    }

    const prompt = [
      'Review the discussion transcript and provide an evaluation:',
      '',
      renderTranscriptText(session.state),
      '',
      'Respond with ONLY valid JSON (no code fences):',
      '{"convergence": 0-10, "summary": "...", "must_answer": [{"to": "agent-name", "question": "..."}]}',
      '',
      'convergence: 0=highly divergent, 10=fully converged',
      'summary: brief synthesis of key positions and progress',
      'must_answer: list of critical questions that need answers before convergence',
    ].join('\n');

    try {
      const content = await this.runFacilitatorTurn(
        EVALUATOR_AGENT_NAME,
        sessionId,
        prompt,
        'You are evaluating convergence in a discussion. Return only valid JSON that matches the requested schema.',
        ctx,
        EPOCH_EVAL_TIMEOUT_MS,
      );
      return this.parseEpochEvaluation(content, session.state);
    } catch {
      return {
        convergence: 0,
        summary: '',
        mustAnswer: [],
      };
    }
  }

  private mustAnswerText(session: DiscussSession, agentName: string): string | null {
    const questions = session.mustAnswerQueue
      .filter((item) => item.to === agentName)
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

  private async runFollowUpTurns(
    sessionId: string,
    mustAnswer: MustAnswerItem[],
    ctx: CallerContext,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || mustAnswer.length === 0) {
      return;
    }

    let nextState = session.state;
    const followUpEntries: FollowUpEntry[] = [];

    for (const item of mustAnswer) {
      const agentRun = this.ensureAgentRun(session, item.to);
      let answer: string;
      try {
        const result = await this.runAgentTurn(
          item.to,
          sessionId,
          agentRun.provider,
          agentRun.model,
          this.buildFollowUpPrompt(nextState, item.to, item.question),
          FOLLOW_UP_TURN_INSTRUCTION,
          this.projectRoot,
          ctx,
          SPEECH_TIMEOUT_MS,
        );
        answer = result.content;
      } catch (error: unknown) {
        answer = error instanceof Error ? error.message : String(error);
      }

      const entry: FollowUpEntry = {
        type: 'follow_up',
        agent: item.to,
        question: item.question,
        answer,
        epoch: nextState.epoch,
        ts: nowIsoString(),
      };
      followUpEntries.push(entry);
      nextState = {
        ...nextState,
        last_activity_at: entry.ts,
        transcript: [...nextState.transcript, entry],
      };
    }

    session.state = nextState;
    session.followUpEntries = [...session.followUpEntries, ...followUpEntries];
    session.mustAnswerQueue = [];
  }

  private async endAndSynthesize(
    sessionId: string,
    opts: { force?: boolean; reason?: string; endReason?: Exclude<EndReason, 'already_ended'> },
    watchData: Record<string, unknown>,
    action: string,
    ctx: CallerContext,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state.status === 'ended') {
      return;
    }

    session.state = unwrapResult(
      applyEnd(session.state, opts, nowIsoString()),
      action,
    );
    this.emitWatch(sessionId, {
      type: 'session_ended',
      data: watchData,
      ts: Date.now(),
    });
    await this.handleSynthesis(sessionId, ctx);
  }

  private async collectBids(sessionId: string, ctx: CallerContext): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.state.status !== 'bidding') {
      return;
    }

    const state = session.state;
    const hadExistingBid = Object.values(state.current_bids).some((score) => score !== null);
    const priorSpeech = lastSpeech(state.transcript);
    const bidders = Object.entries(state.current_bids).filter(
      ([agentName, score]) =>
        score === null
        && !state.agents[agentName]?.banned
        && !this.isManualParticipant(session, agentName),
    );

    const outcomes = await Promise.all(
      bidders.map(async ([agentName]) => {
        const agentRun = this.ensureAgentRun(session, agentName);
        const priorSpeechForAgent =
          priorSpeech !== null && priorSpeech.speaker !== agentName ? priorSpeech : null;
        const mustAnswer = this.mustAnswerText(session, agentName);
        const prompt = buildBidPrompt({
          selfName: agentName,
          state,
          priorSpeech: priorSpeechForAgent,
          mustAnswer,
        });
        const instruction = agentRun.sessionId === undefined
          ? buildFirstTurnInstruction({
            selfName: agentName,
            state,
            priorSpeech: priorSpeechForAgent,
            mustAnswer,
          })
          : CONTINUE_TURN_INSTRUCTION;

        return this.collectBidOutcome(
          sessionId,
          state,
          agentName,
          agentRun,
          prompt,
          instruction,
          ctx,
        );
      }),
    );

    let nextState = state;
    const expelAgents: string[] = [];

    for (const outcome of outcomes) {
      nextState = unwrapResult(
        applyBid(nextState, outcome.agentName, outcome.score, outcome.thought, nowIsoString()),
        `apply bid for ${outcome.agentName}`,
      );
      if (outcome.shouldExpel) {
        expelAgents.push(outcome.agentName);
      }
    }

    if (expelAgents.length > 0) {
      nextState = unwrapResult(
        applyExpel(nextState, expelAgents, nowIsoString()),
        `expel agents ${expelAgents.join(', ')}`,
      ).state;
    }

    const allPendingAgentsFailed =
      outcomes.length > 0 && outcomes.every((outcome) => outcome.executionFailure);
    if (!hadExistingBid && allPendingAgentsFailed) {
      nextState = unwrapResult(
        applyEnd(nextState, { endReason: 'no_participants' }, nowIsoString()),
        'end session after bid failures',
      );
    }

    session.state = nextState;
    if (session.mustAnswerQueue.length > 0 && bidders.length > 0) {
      const bidderNames = new Set(bidders.map(([agentName]) => agentName));
      session.mustAnswerQueue = session.mustAnswerQueue.filter((item) => !bidderNames.has(item.to));
    }
    if (!hadExistingBid && allPendingAgentsFailed) {
      this.emitWatch(sessionId, {
        type: 'session_ended',
        data: { reason: 'no_participants' },
        ts: Date.now(),
      });
    }
  }

  private async collectBidOutcome(
    sessionId: string,
    state: DiscussState,
    agentName: string,
    agentRun: AgentRun,
    prompt: string,
    instruction: string,
    ctx: CallerContext,
  ): Promise<BidOutcome> {
    const shouldExpel = state.agents[agentName]?.participation === 'required';
    let attemptPrompt = prompt;
    let executionFailure = false;

    for (let attempt = 1; attempt <= MAX_BID_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.runAgentTurn(
          agentName,
          sessionId,
          agentRun.provider,
          agentRun.model,
          attemptPrompt,
          instruction,
          this.projectRoot,
          ctx,
          BID_ATTEMPT_TIMEOUT_MS,
        );

        if (result.nonResumable) {
          executionFailure = true;
          break;
        }

        try {
          const bid = parseBidResponse(result.content);
          return {
            agentName,
            score: bid.score,
            thought: bid.thought,
            executionFailure: false,
            shouldExpel: false,
          };
        } catch (error: unknown) {
          if (attempt === MAX_BID_ATTEMPTS) {
            break;
          }
          const failure = error instanceof Error ? error.message : String(error);
          attemptPrompt = buildBidRetryPrompt(prompt, result.content, failure);
        }
      } catch (error: unknown) {
        executionFailure = true;
        if (attempt === MAX_BID_ATTEMPTS) {
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        attemptPrompt = buildBidRetryPrompt(prompt, message, 'execution failure');
      }
    }

    return {
      agentName,
      score: 0,
      thought: '',
      executionFailure,
      shouldExpel: executionFailure && shouldExpel,
    };
  }

  private async collectSpeech(
    sessionId: string,
    winnerName: string,
    ctx: CallerContext,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const agentRun = this.ensureAgentRun(session, winnerName);
    const prompt = buildSpeechPrompt({
      selfName: winnerName,
      state: session.state,
      priorSpeech: null,
    });

    try {
      const result = await this.runAgentTurn(
        winnerName,
        sessionId,
        agentRun.provider,
        agentRun.model,
        prompt,
        CONTINUE_TURN_INSTRUCTION,
        this.projectRoot,
        ctx,
        SPEECH_TIMEOUT_MS,
      );

      if (result.nonResumable) {
        session.state = unwrapResult(
          applySpeechTimeout(session.state, nowIsoString()),
          `apply speech timeout for ${winnerName}`,
        );
        return;
      }

      session.state = unwrapResult(
        applySpeech(session.state, winnerName, result.content, nowIsoString()),
        `apply speech for ${winnerName}`,
      );
      this.emitWatch(sessionId, {
        type: 'speech_done',
        data: {
          speaker: winnerName,
          content: result.content,
        },
        ts: Date.now(),
      });
    } catch {
      session.state = unwrapResult(
        applySpeechTimeout(session.state, nowIsoString()),
        `apply speech timeout for ${winnerName}`,
      );
    }
  }

  private async continueLoop(sessionId: string, ctx: CallerContext): Promise<void> {
    while (true) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return;
      }
      if (session.state.status === 'ended' || session.controller.signal.aborted) {
        return;
      }

      const { state } = session;
      if (state.status === 'bidding') {
        if (state.pending_bidders.length > 0) {
          await this.collectBids(sessionId, ctx);
          continue;
        }

        await this.waitForObserverBidWindow(session);

        const currentSession = this.sessions.get(sessionId);
        if (!currentSession) {
          return;
        }
        if (currentSession.state.status !== 'bidding') {
          continue;
        }
        if (currentSession.controller.signal.aborted) {
          return;
        }

        const resolved = resolveWinner(currentSession.state, nowIsoString());
        if (!resolved.ok) {
          if (resolved.error === 'quorum_not_met') {
            await this.collectBids(sessionId, ctx);
            continue;
          }
          throw new Error(`Discuss manager failed to resolve winner: ${resolved.error}`);
        }

        const [nextState, result] = resolved.value;
        currentSession.state = nextState;

        if ('winner' in result) {
          this.emitWatch(sessionId, {
            type: 'bid_resolved',
            data: {
              winner: result.winner,
              speaker_type: result.speaker_type,
            },
            ts: Date.now(),
          });
          if (this.isManualParticipant(currentSession, result.winner)) {
            return;
          }
          await this.collectSpeech(sessionId, result.winner, ctx);
          await this.collectBids(sessionId, ctx);
          continue;
        }

        if (result.reason === 'epoch_transition') {
          await this.handleEpochTransition(sessionId, ctx);
          const updatedSession = this.sessions.get(sessionId);
          if (!updatedSession || updatedSession.controller.signal.aborted) {
            return;
          }
          if (updatedSession.state.status !== 'bidding') {
            return;
          }
          await this.collectBids(sessionId, ctx);
          continue;
        }

        await this.endDiscussion(sessionId, result.reason, ctx);
        return;
      }

      if (state.status === 'speaking') {
        if (!state.current_speaker) {
          return;
        }
        if (this.isManualParticipant(session, state.current_speaker)) {
          return;
        }
        await this.collectSpeech(sessionId, state.current_speaker, ctx);
        await this.collectBids(sessionId, ctx);
        continue;
      }

      return;
    }
  }

  private async handleEpochTransition(sessionId: string, ctx: CallerContext): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.emitWatch(sessionId, {
      type: 'epoch_transition',
      data: { epoch: session.state.epoch },
      ts: Date.now(),
    });

    const evaluation = await this.evaluateEpoch(sessionId, ctx);
    const currentSession = this.sessions.get(sessionId);
    if (!currentSession || currentSession.state.status !== 'bidding') {
      return;
    }

    if (evaluation.convergence < CONVERGENCE_THRESHOLD) {
      currentSession.state = unwrapResult(
        applyEpochSummary(currentSession.state, evaluation.summary, nowIsoString()),
        `apply epoch summary for session ${sessionId}`,
      );
      currentSession.mustAnswerQueue = evaluation.mustAnswer;
      return;
    }

    if (evaluation.mustAnswer.length === 0) {
      await this.endAndSynthesize(
        sessionId,
        { force: true, reason: 'Discussion converged.' },
        { reason: 'force_end', detail: 'Discussion converged.' },
        'force-end converged discussion',
        ctx,
      );
      return;
    }

    await this.runFollowUpTurns(sessionId, evaluation.mustAnswer, ctx);
    await this.endAndSynthesize(
      sessionId,
      { force: true, reason: 'Discussion converged after follow-ups.' },
      { reason: 'force_end', detail: 'Discussion converged after follow-ups.' },
      'force-end converged discussion after follow-ups',
      ctx,
    );
  }

  private async endDiscussion(
    sessionId: string,
    reason: DiscussionEndReason,
    ctx: CallerContext,
  ): Promise<void> {
    await this.endAndSynthesize(
      sessionId,
      { endReason: reason },
      { reason },
      `end discussion with reason ${reason}`,
      ctx,
    );
  }

  private async handleSynthesis(sessionId: string, ctx: CallerContext): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state.status !== 'ended') {
      return;
    }

    try {
      const prompt = [
        'Write the final synthesis for this discussion.',
        '',
        renderTranscriptText(session.state),
        '',
        session.followUpEntries.length > 0
          ? 'The transcript includes moderator follow-up answers. Incorporate them into the final synthesis.'
          : null,
        'Respond with the final synthesis text only. Do not use markdown or code fences.',
      ]
        .filter((section): section is string => section !== null)
        .join('\n');

      const content = await this.runFacilitatorTurn(
        SYNTHESIS_AGENT_NAME,
        sessionId,
        prompt,
        'You are writing the final synthesis for a discussion. Return only the synthesis text.',
        ctx,
        SPEECH_TIMEOUT_MS,
      );
      session.state = unwrapResult(
        applySynthesis(session.state, content, nowIsoString()),
        `apply synthesis for session ${sessionId}`,
      );
    } catch {
      return;
    }
  }

  private async forceEndAfterLoopFailure(sessionId: string, error: unknown): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.state.status === 'ended') {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    session.state = unwrapResult(
      applyEnd(session.state, { force: true, reason: detail }, nowIsoString()),
      'force-end discussion after loop failure',
    );
    this.emitWatch(sessionId, {
      type: 'session_ended',
      data: { reason: 'force_end', detail },
      ts: Date.now(),
    });
  }

  private async waitForObserverBidWindow(session: DiscussSession): Promise<void> {
    if (session.state.min_bid_delay_ms <= 0) {
      return;
    }

    const pendingObserverBidExists = Object.entries(session.state.current_bids).some(([name, score]) =>
      session.state.agents[name]?.participation === 'observer'
      && !session.state.agents[name]?.banned
      && score === null,
    );
    if (!pendingObserverBidExists) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, session.state.min_bid_delay_ms);
    });
  }
}

export class DiscussManagerRegistry {
  private readonly managers = new Map<string, DiscussManager>();

  getOrCreate(projectRoot: string, service: ExecutionService): DiscussManager {
    const existing = this.managers.get(projectRoot);
    if (existing) return existing;

    const manager = new DiscussManager(projectRoot, service);
    this.managers.set(projectRoot, manager);
    return manager;
  }

  get(projectRoot: string): DiscussManager | undefined {
    return this.managers.get(projectRoot);
  }

  listLiveSessions(): Array<{ projectRoot: string; sessionId: string; session: DiscussSession }> {
    const sessions: Array<{ projectRoot: string; sessionId: string; session: DiscussSession }> = [];
    for (const [projectRoot, manager] of this.managers.entries()) {
      for (const [sessionId, session] of manager.listSessions()) {
        sessions.push({ projectRoot, sessionId, session });
      }
    }
    return sessions;
  }

  hasLiveSessions(): boolean {
    for (const manager of this.managers.values()) {
      if (manager.hasLiveSessions()) return true;
    }
    return false;
  }
}
