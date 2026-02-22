/**
 * Coral Discuss MCP server handlers.
 */

import { textResult, jsonResult, type McpResult } from '../shared/mcp-utils.js';
import type {
  EndReason,
  DiscussState,
} from './types.js';
import { SessionStore } from './session-store.js';
import {
  applyBid,
  applyEnd,
  applyEpochSummary,
  applyExpel,
  applySpeech,
  applySpeechTimeout,
  initSession,
  resolveAgentName,
  resolveWinner,
  startBidding,
  DEFAULT_BID_THRESHOLD,
  DEFAULT_MAX_EPOCHS,
  DEFAULT_QUOTA_PER_EPOCH,
} from './state-machine.js';
import {
  allBidsIn,
  bidReleased,
  isWinner,
  noParticipants,
  setupComplete,
  speechDelivered,
} from './conditions.js';
import { waitForCondition, INFINITE_POLL } from './wait.js';
import { formatFull, formatRecent, formatSummary } from './transcript.js';
import { seedPersonas } from './persona-seed.js';
import {
  discussAgentOpSchema,
  discussLeadOpSchema,
  type DiscussAgentOpInput,
  type DiscussLeadOpInput,
} from './schemas.js';
import type { Result } from './types.js';

function resolveSession(store: SessionStore, sessionId: string): string | McpResult {
  const dir = store.resolveDir(sessionId);
  return dir ?? textResult('session_not_found', true);
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function envInt(key: string, min: number, max: number, fallback: number): number {
  const raw = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

function resultToMcp(result: Result<unknown>): McpResult {
  if (!result.ok) {
    return jsonResult({ error: result.error, ...result.detail });
  }
  return jsonResult(result.value as Record<string, unknown>);
}

async function loadState(store: SessionStore, sessionDir: string): Promise<DiscussState> {
  return store.withLock(sessionDir, async () => store.load(sessionDir));
}

function endContent(reason: Exclude<EndReason, 'already_ended'>): string {
  switch (reason) {
    case 'all_below_threshold':
      return 'All participants bid below the threshold. Ending discussion.';
    case 'max_epochs_reached':
      return 'Maximum epochs reached. Ending discussion.';
    case 'all_blocked':
      return 'Discussion is structurally deadlocked. Agents who want to speak have no quota, and agents with quota do not want to speak.';
    case 'no_participants':
      return 'No eligible agents remaining. Ending discussion.';
    default:
      return 'Ending discussion.';
  }
}

export const tools = [
  {
    name: 'discuss',
    description: 'Discussion agent tool. Use op field to select operation: bid (submit score), speak (record speech).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: { type: 'string', enum: ['bid', 'speak'] },
        session: { type: 'string', description: 'Session ID' },
        agent_name: { type: 'string', description: 'Agent name' },
        score: { type: 'number', minimum: 0, maximum: 100 },
        content: { type: 'string', description: 'Speech content (speak)' },
      },
      required: ['op', 'session', 'agent_name'],
    },
  },
  {
    name: 'discuss_lead',
    description:
      'Discussion moderator tool. Ops: _1_seed (persona sampling), _2_create, _3_step (bid collect / speech wait), _4_transcript, _5_epoch, _6_state, _7_end.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: {
          type: 'string',
          enum: ['_1_seed', '_2_create', '_3_step', '_4_transcript', '_5_epoch', '_6_state', '_7_end'],
        },
        topic: { type: 'string', description: 'Discussion topic (_2_create)' },
        agents: {
          type: 'array',
          description: 'Agent list (_2_create)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              persona: { type: 'string' },
            },
            required: ['name', 'persona'],
          },
          minItems: 2,
          maxItems: 8,
        },
        controversy_axes: {
          type: 'array',
          description: 'Persona seed axes (_1_seed)',
          items: {
            type: 'object',
            properties: {
              axis: { type: 'string' },
              positions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
            },
            required: ['axis', 'positions'],
          },
          minItems: 1,
          maxItems: 10,
        },
        n: { type: 'integer', minimum: 1, maximum: 8, description: 'Seed count (_1_seed)' },
        seed: { type: ['integer', 'null'], description: 'Seed value (_1_seed)' },
        session: { type: 'string', description: 'Session ID' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 120, description: '_3_step timeout (seconds)' },
        force_stop: { type: 'boolean', description: '_3_step timeout escalation flag' },
        mode: { type: 'string', enum: ['full', 'recent', 'summary'], description: '_4_transcript' },
        last_n: { type: 'integer', minimum: 1, maximum: 50, description: 'Override recent turns (_4_transcript)' },
        summary: { type: 'string', description: 'Epoch summary (_5_epoch)' },
        synthesis: { type: 'string', description: 'Synthesis text (_7_end)' },
        force: { type: 'boolean', description: 'Force end during speaking (_7_end)' },
        reason: { type: 'string', description: 'Force reason (_7_end)' },
      },
      required: ['op'],
    },
  },
];

async function handleBid(
  input: Extract<DiscussAgentOpInput, { op: 'bid' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;
  const statePath = store.statePath(sessionDir);

  type BidPre =
    | { kind: 'banned'; state: DiscussState; resolved: string }
    | { kind: 'ended'; state: DiscussState; resolved: string }
    | { kind: 'setup' }
    | { kind: 'speaking' }
    | { kind: 'bidding'; resolved: string };
  type BidRecordResult = Result<{ state: DiscussState; step: number }>;

  const waitForSetupComplete = async () => waitForCondition(statePath, setupComplete, INFINITE_POLL);

  while (true) {
    const pre = await store.withLock< Result<BidPre> >(sessionDir, async () => {
      const state = store.load(sessionDir);
      const resolved = resolveAgentName(state.agents, input.agent_name);
      if (!resolved) {
        return { ok: false, error: 'agent_not_found', detail: { agent_name: input.agent_name } };
      }
      if (state.agents[resolved]?.banned) {
        return { ok: true, value: { kind: 'banned', resolved, state } };
      }
      switch (state.status) {
        case 'ended':
          return { ok: true, value: { kind: 'ended', resolved, state } };
        case 'setup':
          return { ok: true, value: { kind: 'setup' } };
        case 'speaking':
          return { ok: true, value: { kind: 'speaking' } };
        case 'bidding':
          return { ok: true, value: { kind: 'bidding', resolved } };
        default:
          return { ok: false, error: 'invalid_status', detail: { current: state.status } };
      }
    });

    if (!pre.ok) {
      return resultToMcp(pre);
    }

    const phase = pre.value.kind;
    switch (phase) {
      case 'banned':
        return jsonResult({ action: 'session_ended', reason: 'banned' });
      case 'ended':
        return jsonResult({
          action: 'session_ended',
          reason: 'already_ended',
          content: pre.value.state.end_reason_content ?? undefined,
        });
      case 'setup': {
        const waited = await waitForSetupComplete();
        if (!waited.fulfilled) return jsonResult({ error: waited.error ?? 'setup_wait_failed' });
        continue;
      }
      case 'speaking': {
        const waited = await waitForCondition(
          statePath,
          (s) => s.status === 'bidding' || s.status === 'ended',
          INFINITE_POLL,
        );
        if (!waited.fulfilled) return jsonResult({ error: waited.error ?? 'speaking_wait_failed' });
        continue;
      }
      case 'bidding': {
        const resolved = pre.value.resolved;
        const bidStepResult = await store.withLock<BidRecordResult>(sessionDir, async () => {
          const state = store.load(sessionDir);
          if (state.status !== 'bidding') {
            return { ok: false, error: 'not_bidding', detail: { current: state.status } };
          }
          const result = applyBid(state, resolved, input.score, nowIsoString());
          if (!result.ok) {
            return { ok: false, error: result.error, detail: result.detail };
          }
          store.save(sessionDir, result.value);
          return { ok: true, value: { state: result.value, step: result.value.step } };
        });

        if (!bidStepResult.ok) {
          if (bidStepResult.error === 'not_bidding') {
            continue;
          }
          return resultToMcp(bidStepResult);
        }

        const bidStep = bidStepResult.value.step;
        const released = await waitForCondition(
          statePath,
          (s) => isWinner(resolved)(s) || bidReleased(resolved, bidStep)(s),
          INFINITE_POLL,
        );
        if (!released.fulfilled) {
          return jsonResult({ error: released.error ?? 'bid_wait_failed' });
        }

        const finalState = await loadState(store, sessionDir);

        const finalAgentState = finalState.agents[resolved];
        if (finalAgentState?.banned) {
          return jsonResult({ action: 'session_ended', reason: 'banned' });
        }

        if (finalState.status === 'ended') {
          return jsonResult({ action: 'session_ended', reason: 'already_ended', content: finalState.end_reason_content });
        }

        if (isWinner(resolved)(finalState)) {
          return jsonResult({
            action: 'speak',
            transcript: formatFull(finalState.transcript, finalState.agents),
          });
        }

        const last = finalState.transcript[finalState.transcript.length - 1];
        if (!last) {
          return jsonResult({ action: 'session_ended' });
        }

        if (last.type === 'speech') {
          return jsonResult({ action: 'listen', speaker: last.agent, content: last.content });
        }
        if (last.type === 'epoch_summary') {
          return jsonResult({ action: 'listen', speaker: 'moderator', content: last.summary });
        }
        return jsonResult({ action: 'session_ended' });
      }
    }
  }
}

async function handleSpeak(
  input: Extract<DiscussAgentOpInput, { op: 'speak' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const applied = await store.withLock(sessionDir, async () => {
    const state = store.load(sessionDir);
    const resolved = resolveAgentName(state.agents, input.agent_name);
    if (!resolved) {
      return { ok: false, error: 'agent_not_found', detail: { agent_name: input.agent_name } } as Result<never>;
    }
    const result = applySpeech(state, resolved, input.content, nowIsoString());
    if (!result.ok) return result as Result<never>;
    store.save(sessionDir, result.value);
    return {
      ok: true,
      value: {
        status: result.value.status,
        step: result.value.step,
      },
    } as Result<{ status: string; step: number }>;
  });

  return resultToMcp(applied);
}

async function handleAgentOp(input: DiscussAgentOpInput, store: SessionStore): Promise<McpResult> {
  if (input.op === 'bid') return handleBid(input, store);
  return handleSpeak(input, store);
}

async function handle1Seed(input: Extract<DiscussLeadOpInput, { op: '_1_seed' }>): Promise<McpResult> {
  return jsonResult(seedPersonas(input));
}

async function handle2Create(
  input: Omit<Extract<DiscussLeadOpInput, { op: '_2_create' }>, 'op'>,
  store: SessionStore,
): Promise<McpResult> {
  store.cleanupExpiredSessions();
  const now = nowIsoString();
  const bidThreshold = envInt('CORAL_DISCUSS_BID_THRESHOLD', 1, 100, DEFAULT_BID_THRESHOLD);
  const maxEpochs = envInt('CORAL_DISCUSS_MAX_EPOCHS', 1, 10, DEFAULT_MAX_EPOCHS);
  const quotaPerEpoch = envInt('CORAL_DISCUSS_QUOTA_PER_EPOCH', 1, 10, DEFAULT_QUOTA_PER_EPOCH);

  const state = initSession(input, now, bidThreshold, maxEpochs, quotaPerEpoch);
  const { sessionId, sessionDir, fullPath } = store.createSessionDir(input.topic);
  state.session_id = sessionId;
  state.session_dir = sessionDir;
  state.team_name = `coral-dc-${sessionId}`;

  await store.withLock(fullPath, async () => {
    store.initTranscript(fullPath, input.topic);
    store.save(fullPath, state);
  });

  return jsonResult({
    session_id: sessionId,
    session_dir: fullPath,
    team_name: state.team_name,
    topic: input.topic,
    status: state.status,
    bid_threshold: state.bid_threshold,
    max_epochs: state.max_epochs,
    agents: Object.keys(state.agents),
  });
}

async function handle3Step(
  input: Extract<DiscussLeadOpInput, { op: '_3_step' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;
  const statePath = store.statePath(sessionDir);
  const now = nowIsoString();
  const timeoutMs = input.timeout_seconds * 1000;

  type BiddingPre = {
    kind: 'wait';
    state: DiscussState;
  } | {
    kind: 'ended';
    reason: EndReason;
    state: DiscussState;
  } | {
    kind: 'expelled';
    agents: string[];
    hint: string;
    state: DiscussState;
  };

  type ResolvePhase =
    | { kind: 'resolved'; winner: string }
    | { kind: 'epoch_transition'; epoch: number }
    | { kind: 'ended'; reason: EndReason };

  type SpeakingWait =
    | { kind: 'ended' }
    | { kind: 'speech_done'; speech: { agent: string; content: string } }
    | { kind: 'speech_timeout'; speaker: string };

  const preState = await store.withLock<Result<DiscussState>>(sessionDir, async () => {
    const state = store.load(sessionDir);
    if (state.status !== 'setup') {
      return { ok: true, value: state };
    }
    const started = startBidding(state, now);
    if (!started.ok) {
      return { ok: false, error: 'not_ready', detail: { current: state.status } };
    }
    store.save(sessionDir, started.value);
    return { ok: true, value: started.value };
  });
  if (!preState.ok) return resultToMcp(preState);

  let state = preState.value;
  if (state.status === 'ended') {
    return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
  }

  if (state.status === 'speaking') {
    const waitResult = await waitForCondition(
      statePath,
      (s) => speechDelivered(s) || s.status === 'ended',
      timeoutMs,
    );

    if (!waitResult.fulfilled) {
      return jsonResult({
        status: 'speaking',
        phase: 'speech_pending',
        elapsed: waitResult.elapsed_ms / 1000,
      });
    }

    const speechState = await store.withLock<Result<SpeakingWait>>(sessionDir, async () => {
      const current = store.load(sessionDir);
      if (current.status === 'ended') {
        return { ok: true, value: { kind: 'ended' } };
      }

      if (current.status === 'bidding') {
        const speech = current.transcript[current.transcript.length - 1];
        if (!speech || speech.type !== 'speech') {
          return { ok: false, error: 'expected_speech_entry' };
        }

        return {
          ok: true,
          value: { kind: 'speech_done', speech: { agent: speech.agent, content: speech.content } },
        };
      }

      if (!input.force_stop || current.status !== 'speaking' || !current.current_speaker) {
        return { ok: false, error: 'speech_not_done', detail: { current: current.status } };
      }

      const timed = applySpeechTimeout(current, now);
      if (!timed.ok) return { ok: false, error: timed.error, detail: timed.detail };
      store.save(sessionDir, timed.value);
      return { ok: true, value: { kind: 'speech_timeout', speaker: current.current_speaker } };
    });

    if (!speechState.ok) {
      return resultToMcp(speechState);
    }

    if (speechState.value.kind === 'speech_timeout') {
      return jsonResult({
        status: 'speaking',
        phase: 'speech_timeout',
        speaker: speechState.value.speaker,
      });
    }

    if (speechState.value.kind === 'ended') {
      return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
    }

    return jsonResult({
      status: 'speaking',
      phase: 'speech_done',
      speaker: speechState.value.speech.agent,
      content: speechState.value.speech.content,
    });
  }

  if (state.status === 'bidding') {
    const beforeResolve = await store.withLock<Result<BiddingPre>>(sessionDir, async () => {
      const current = store.load(sessionDir);
      if (current.status !== 'bidding') {
        if (current.status === 'ended') {
          return { ok: true, value: { kind: 'ended', reason: 'already_ended' as const, state: current } };
        }
        return {
          ok: false,
          error: 'invalid_status',
          detail: { current: current.status },
        };
      }

      const next = { ...current, hold_count: current.hold_count + 1 };
      if (noParticipants(current)) {
        const endedState = applyEnd(
          {
            ...next,
            end_reason_content: endContent('no_participants'),
          },
          {},
          now,
        );
        if (!endedState.ok) return { ok: false, error: endedState.error, detail: endedState.detail };
        store.save(sessionDir, endedState.value);
        return { ok: true, value: { kind: 'ended', reason: 'no_participants', state: endedState.value } };
      }

      if (next.hold_count >= 2 && next.pending_bidders.length > 0) {
        const expel = applyExpel(next, next.pending_bidders, now);
        if (!expel.ok) {
          return { ok: false, error: expel.error, detail: expel.detail };
        }

        if (noParticipants(expel.value.state)) {
          const endedState = applyEnd(
            {
              ...expel.value.state,
              end_reason_content: endContent('no_participants'),
            },
            {},
            now,
          );
          if (!endedState.ok) return { ok: false, error: endedState.error, detail: endedState.detail };
          store.save(sessionDir, endedState.value);
          return { ok: true, value: { kind: 'ended', reason: 'no_participants', state: endedState.value } };
        }

        store.save(sessionDir, expel.value.state);
        return {
          ok: true,
          value: { kind: 'expelled', state: expel.value.state, agents: next.pending_bidders, hint: expel.value.hint },
        };
      }

      store.save(sessionDir, next);
      return { ok: true, value: { kind: 'wait', state: next } };
    });

    if (!beforeResolve.ok) return resultToMcp(beforeResolve);

    if (beforeResolve.value.kind === 'ended') {
      return jsonResult({ status: 'bidding', phase: 'ended', reason: beforeResolve.value.reason });
    }

    if (beforeResolve.value.kind === 'expelled') {
      return jsonResult({
        status: 'bidding',
        phase: 'expelled',
        agents: beforeResolve.value.agents,
        hint: beforeResolve.value.hint,
      });
    }

    const waited = await waitForCondition(
      statePath,
      (s) => allBidsIn(s) || s.status === 'ended',
      timeoutMs,
    );
    if (!waited.fulfilled) {
      state = await loadState(store, sessionDir);
      if (state.status === 'ended') {
        return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
      }
      return jsonResult({
        status: 'bidding',
        phase: 'bidding',
        pending_bidders: state.pending_bidders,
        hold_count: state.hold_count,
      });
    }

    state = await loadState(store, sessionDir);
    if (state.status === 'ended') {
      return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
    }

    const resolved = await store.withLock<Result<ResolvePhase>>(sessionDir, async () => {
      const current = store.load(sessionDir);
      if (current.status === 'ended') {
        return { ok: true, value: { kind: 'ended', reason: 'already_ended' as const } };
      }
      if (current.status !== 'bidding' || !allBidsIn(current)) {
        return { ok: false, error: 'bids_not_complete', detail: { pending_bidders: current.pending_bidders } };
      }

      const winnerResult = resolveWinner(current, now);
      if (!winnerResult.ok) {
        return { ok: false, error: winnerResult.error, detail: winnerResult.detail };
      }
      const [nextState, decision] = winnerResult.value;

      if ('speaker_type' in decision) {
        store.save(sessionDir, nextState);
        return { ok: true, value: { kind: 'resolved', winner: decision.winner } };
      }

      if (decision.reason === 'epoch_transition') {
        store.save(sessionDir, nextState);
        return { ok: true, value: { kind: 'epoch_transition', epoch: nextState.epoch } };
      }

      const endedState = applyEnd(
        {
          ...nextState,
          end_reason_content: endContent(decision.reason),
        },
        {},
        now,
      );
      if (!endedState.ok) return { ok: false, error: endedState.error, detail: endedState.detail };
      store.save(sessionDir, endedState.value);

      return { ok: true, value: { kind: 'ended', reason: decision.reason } };
    });

    if (!resolved.ok) return resultToMcp(resolved);

    if (resolved.value.kind === 'resolved') {
      return jsonResult({ status: 'bidding', phase: 'resolved', winner: resolved.value.winner });
    }
    if (resolved.value.kind === 'epoch_transition') {
      return jsonResult({ status: 'bidding', phase: 'epoch_transition', epoch: resolved.value.epoch });
    }
    return jsonResult({ status: 'bidding', phase: 'ended', reason: resolved.value.reason });
  }

  return jsonResult({ status: 'setup', phase: 'not_ready' });
}
async function handle4Transcript(
  input: Extract<DiscussLeadOpInput, { op: '_4_transcript' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const state = await loadState(store, sessionDir);
  let text: string;

  switch (input.mode) {
    case 'full':
      text = formatFull(state.transcript, state.agents);
      break;
    case 'summary':
      text = formatSummary(state.transcript, state.agents);
      break;
    default:
      text = formatRecent(state.transcript, input.last_n ?? 5, state.agents);
      break;
  }

  return textResult(text);
}

async function handle5Epoch(
  input: Extract<DiscussLeadOpInput, { op: '_5_epoch' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const applied = await store.withLock<Result<{ recorded: true; epoch: number }>>(sessionDir, async () => {
    const state = store.load(sessionDir);
    const result = applyEpochSummary(state, input.summary, nowIsoString());
    if (!result.ok) return result;
    store.save(sessionDir, result.value);
    return { ok: true, value: { recorded: true, epoch: state.epoch } };
  });

  return resultToMcp(applied);
}

async function handle6State(
  input: Extract<DiscussLeadOpInput, { op: '_6_state' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const state = await loadState(store, sessionDir);

  return jsonResult({
    session_id: state.session_id,
    topic: state.topic,
    status: state.status,
    step: state.step,
    epoch: state.epoch,
    current_speaker: state.current_speaker,
    speaker_type: state.speaker_type,
    cold_start: state.cold_start,
    bid_threshold: state.bid_threshold,
    hold_count: state.hold_count,
    agents: Object.fromEntries(
      Object.entries(state.agents).map(([name, agent]) => [
        name,
        {
          display_name: agent.display_name,
          total_speaks: agent.total_speaks,
          quota_remaining: agent.quota_remaining,
          fallback_used: agent.fallback_used,
          banned: agent.banned,
        },
      ]),
    ),
    pending_bidders: state.pending_bidders,
    total_agents: Object.keys(state.agents).length,
  });
}

async function handle7End(
  input: Extract<DiscussLeadOpInput, { op: '_7_end' }>,
  store: SessionStore,
): Promise<McpResult> {
  if (input.force && !input.reason?.trim()) {
    return textResult('reason is required when force=true', true);
  }

  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const ended = await store.withLock<Result<{ status: string }>>(sessionDir, async () => {
    const state = store.load(sessionDir);
    const result = applyEnd(
      state,
      {
        force: input.force,
        reason: input.reason,
        synthesis: input.synthesis,
      },
      nowIsoString(),
    );
    if (!result.ok) return result;
    if (result.value !== state) {
      store.save(sessionDir, result.value);
    }
    return { ok: true, value: { status: result.value.status } };
  });

  return resultToMcp(ended);
}

async function handleDiscussLeadOp(input: DiscussLeadOpInput, store: SessionStore): Promise<McpResult> {
  switch (input.op) {
    case '_1_seed':
      return handle1Seed(input);
    case '_2_create':
      return handle2Create(input, store);
    case '_3_step':
      return handle3Step(input, store);
    case '_4_transcript':
      return handle4Transcript(input, store);
    case '_5_epoch':
      return handle5Epoch(input, store);
    case '_6_state':
      return handle6State(input, store);
    case '_7_end':
      return handle7End(input, store);
    default:
      return jsonResult({ error: 'invalid_op' });
  }
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
  store: SessionStore,
): Promise<McpResult> {
  try {
    switch (name) {
      case 'discuss': {
        const parsed = discussAgentOpSchema.safeParse(rawArgs);
        if (!parsed.success) {
          const maybeOp = (rawArgs as { op?: unknown }).op;
          if (parsed.error.issues.some((i) => i.code === 'invalid_union_discriminator') && maybeOp !== undefined) {
            return jsonResult({ error: 'unknown_op', op: maybeOp });
          }
          throw parsed.error;
        }
        return handleAgentOp(parsed.data, store);
      }

      case 'discuss_lead': {
        const parsed = discussLeadOpSchema.safeParse(rawArgs);
        if (!parsed.success) {
          const maybeOp = (rawArgs as { op?: unknown }).op;
          if (parsed.error.issues.some((i) => i.code === 'invalid_union_discriminator') && maybeOp !== undefined) {
            return jsonResult({ error: 'unknown_op', op: maybeOp });
          }
          throw parsed.error;
        }
        return handleDiscussLeadOp(parsed.data, store);
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(`Error: ${message}`, true);
  }
}
