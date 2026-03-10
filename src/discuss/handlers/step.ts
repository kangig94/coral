import { jsonResult, type McpResult } from '../../shared/mcp-utils.js';
import { discussEventLogPath } from '../../client/paths.js';
import type { EndReason, DiscussState, Result } from '../types.js';
import type { DiscussLeadOpInput } from '../schemas.js';
import type { SessionStore } from '../session-store.js';
import { prepareMutation, type DiscussMachineEvent } from '../event-log.js';
import {
  startBidding,
  resolveWinner,
  applySpeechTimeout,
  applyExpel,
  applyEnd,
  endContent,
} from '../state-machine.js';
import { allBidsIn, speechDelivered, noEligibleParticipants, waitForCondition } from '../wait.js';
import { nowIsoString } from '../util/time.js';

type StepContext = {
  sessionDir: string;
  statePath: string;
  timeoutMs: number;
};

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

function endNoParticipants(
  mutatedState: DiscussState,
  sessionDir: string,
  now: string,
  store: SessionStore,
  expelledAgents?: string[],
): Result<BiddingPre> {
  const endedState = applyEnd(
    {
      ...mutatedState,
      end_reason_content: endContent('no_participants'),
    },
    {},
    now,
  );
  if (!endedState.ok) return { ok: false, error: endedState.error, detail: endedState.detail };
  const state = endedState.value;
  const eventLogPath = discussEventLogPath(sessionDir);
  const eventCount = expelledAgents ? 2 : 1;
  const { nextSeq, watermark } = prepareMutation(eventLogPath, eventCount);
  const events: DiscussMachineEvent[] = [];
  if (expelledAgents) {
    events.push({
      sessionId: state.session_id,
      topic: state.topic,
      projectRoot: store.projectRoot,
      seq: nextSeq,
      kind: 'agents_expelled',
      ts: now,
      payload: { agents: expelledAgents, mode: 'ban' },
    });
  }
  events.push({
    sessionId: state.session_id,
    topic: state.topic,
    projectRoot: store.projectRoot,
    seq: expelledAgents ? nextSeq + 1 : nextSeq,
    kind: 'session_ended',
    ts: now,
    payload: { reason: 'no_participants' },
  });
  store.persistMutation(sessionDir, state, events, watermark);
  return { ok: true, value: { kind: 'ended', reason: 'no_participants', state } };
}

async function bootstrapFromSetup(ctx: StepContext, store: SessionStore): Promise<Result<DiscussState>> {
  return store.withLock<Result<DiscussState>>(ctx.sessionDir, async () => {
    const state = store.load(ctx.sessionDir);
    if (state.status !== 'setup') return { ok: true, value: state };
    const started = startBidding(state, nowIsoString());
    if (!started.ok) return { ok: false, error: 'not_ready', detail: { current: state.status } };
    const eventLogPath = discussEventLogPath(ctx.sessionDir);
    const { nextSeq, watermark } = prepareMutation(eventLogPath, 1);
    store.persistMutation(ctx.sessionDir, started.value, [{
      sessionId: started.value.session_id,
      topic: started.value.topic,
      projectRoot: store.projectRoot,
      seq: nextSeq,
      kind: 'bidding_started',
      ts: nowIsoString(),
      payload: { epoch: started.value.epoch, step: started.value.step },
    }], watermark);
    return { ok: true, value: started.value };
  });
}

async function stepSpeaking(
  ctx: StepContext,
  input: Extract<DiscussLeadOpInput, { op: '_3_step' }>,
  store: SessionStore,
): Promise<McpResult> {
  const waited = await waitForCondition(
    ctx.statePath,
    (s) => speechDelivered(s) || s.status === 'ended',
    ctx.timeoutMs,
  );
  if (waited.error === 'state_corrupt') {
    return jsonResult({ status: 'error', phase: 'state_corrupt', message: 'Consecutive state read failures' });
  }
  if (!waited.fulfilled) {
    return jsonResult({
      status: 'speaking',
      phase: 'speech_pending',
      elapsed: waited.elapsed_ms / 1000,
    });
  }

  const speechState = await store.withLock<Result<SpeakingWait>>(ctx.sessionDir, async () => {
    const current = store.load(ctx.sessionDir);
    if (current.status === 'ended') {
      return { ok: true, value: { kind: 'ended' } };
    }

    if (current.status === 'bidding') {
      const lastEntry = current.transcript[current.transcript.length - 1];
      if (!lastEntry || lastEntry.type !== 'speech') {
        return { ok: false, error: 'expected_speech_entry' };
      }
      return {
        ok: true,
        value: { kind: 'speech_done', speech: { agent: lastEntry.agent, content: lastEntry.content } },
      };
    }

    if (!input.force_stop || current.status !== 'speaking' || !current.current_speaker) {
      return { ok: false, error: 'speech_not_done', detail: { current: current.status } };
    }

    const timed = applySpeechTimeout(current, nowIsoString());
    if (!timed.ok) return { ok: false, error: timed.error, detail: timed.detail };
    const speaker = current.current_speaker ?? '';
    const speechTimeoutLogPath = discussEventLogPath(ctx.sessionDir);
    const { nextSeq: speechTimeoutSeq, watermark: speechTimeoutWm } = prepareMutation(speechTimeoutLogPath, 1);
    store.persistMutation(ctx.sessionDir, timed.value, [{
      sessionId: timed.value.session_id,
      topic: timed.value.topic,
      projectRoot: store.projectRoot,
      seq: speechTimeoutSeq,
      kind: 'speech_timeout',
      ts: nowIsoString(),
      payload: { speaker },
    }], speechTimeoutWm);
    return { ok: true, value: { kind: 'speech_timeout', speaker: current.current_speaker } };
  });
  if (!speechState.ok) return jsonResult({ error: speechState.error, ...(speechState.detail ?? {}) });

  switch (speechState.value.kind) {
    case 'speech_timeout':
      return jsonResult({
        status: 'speaking',
        phase: 'speech_timeout',
        speaker: speechState.value.speaker,
      });
    case 'ended':
      return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
    case 'speech_done':
      return jsonResult({
        status: 'speaking',
        phase: 'speech_done',
        speaker: speechState.value.speech.agent,
        content: speechState.value.speech.content,
      });
  }
}

async function stepBidding(ctx: StepContext, store: SessionStore): Promise<McpResult> {
  const beforeResolve = await store.withLock<Result<BiddingPre>>(ctx.sessionDir, async () => {
    const current = store.load(ctx.sessionDir);
    if (current.status !== 'bidding') {
      if (current.status === 'ended') {
        return { ok: true, value: { kind: 'ended', reason: 'already_ended', state: current } };
      }
      return { ok: false, error: 'invalid_status', detail: { current: current.status } };
    }

    const nowMs = Date.now();
    const next = {
      ...current,
      pending_since_ts: current.pending_since_ts ?? nowMs,
    };
    if (noEligibleParticipants(current)) {
      return endNoParticipants(next, ctx.sessionDir, nowIsoString(), store);
    }

    const isFirstRound = next.epoch === 1 && next.step === 1;
    const expelTtlMs = Number(process.env.CORAL_DISCUSS_EXPEL_TTL_MS) || (ctx.timeoutMs * 2);
    const pendingTooLong =
      next.pending_since_ts !== null && (nowMs - next.pending_since_ts) >= expelTtlMs;
    if (!isFirstRound && pendingTooLong && next.pending_bidders.length > 0) {
      const expel = applyExpel(next, next.pending_bidders, nowIsoString());
      if (!expel.ok) return { ok: false, error: expel.error, detail: expel.detail };
      if (noEligibleParticipants(expel.value.state)) {
        return endNoParticipants(expel.value.state, ctx.sessionDir, nowIsoString(), store, next.pending_bidders);
      }
      const expelLogPath = discussEventLogPath(ctx.sessionDir);
      const { nextSeq: expelSeq, watermark: expelWm } = prepareMutation(expelLogPath, 1);
      store.persistMutation(ctx.sessionDir, expel.value.state, [{
        sessionId: expel.value.state.session_id,
        topic: expel.value.state.topic,
        projectRoot: store.projectRoot,
        seq: expelSeq,
        kind: 'agents_expelled',
        ts: nowIsoString(),
        payload: { agents: next.pending_bidders, mode: 'ban' },
      }], expelWm);
      return {
        ok: true,
        value: { kind: 'expelled', state: expel.value.state, agents: next.pending_bidders, hint: expel.value.hint },
      };
    }

    const pendingLogPath = discussEventLogPath(ctx.sessionDir);
    const { watermark: pendingWm } = prepareMutation(pendingLogPath, 0);
    store.persistMutation(ctx.sessionDir, next, [], pendingWm);
    return { ok: true, value: { kind: 'wait', state: next } };
  });
  if (!beforeResolve.ok) return jsonResult({ error: beforeResolve.error, ...(beforeResolve.detail ?? {}) });

  switch (beforeResolve.value.kind) {
    case 'ended':
      return jsonResult({ status: 'bidding', phase: 'ended', reason: beforeResolve.value.reason });
    case 'expelled':
      return jsonResult({
        status: 'bidding',
        phase: 'expelled',
        agents: beforeResolve.value.agents,
        hint: beforeResolve.value.hint,
      });
    case 'wait':
      break;
  }

  const waited = await waitForCondition(
    ctx.statePath,
    (s) => allBidsIn(s) || s.status === 'ended',
    ctx.timeoutMs,
  );
  if (waited.error === 'state_corrupt') {
    return jsonResult({ status: 'error', phase: 'state_corrupt', message: 'Consecutive state read failures' });
  }
  if (!waited.fulfilled) {
    const state = waited.state;
    if (!state || state.status === 'ended') {
      return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
    }
    return jsonResult({
      status: 'bidding',
      phase: 'bidding',
      pending_bidders: state.pending_bidders,
      pending_since_ts: state.pending_since_ts,
    });
  }

  if (!waited.state || waited.state.status === 'ended') {
    return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
  }

  const allAgentsBid = (s: DiscussState): boolean =>
    Object.entries(s.agents).every(([name, agent]) => agent.banned || s.current_bids[name] != null);

  if (waited.state.min_bid_delay_ms > 0) {
    const delayed = await waitForCondition(ctx.statePath, allAgentsBid, waited.state.min_bid_delay_ms);
    if (!delayed.fulfilled && delayed.error === 'state_corrupt') {
      return jsonResult({ status: 'error', phase: 'state_corrupt', message: 'Consecutive state read failures' });
    }
  }

  const resolved = await store.withLock<Result<ResolvePhase>>(ctx.sessionDir, async () => {
    const current = store.load(ctx.sessionDir);
    if (current.status === 'ended') {
      return { ok: true, value: { kind: 'ended', reason: 'already_ended' } };
    }
    if (current.status !== 'bidding' || !allBidsIn(current)) {
      return { ok: false, error: 'bids_not_complete', detail: { pending_bidders: current.pending_bidders } };
    }

    const winnerResult = resolveWinner(current, nowIsoString());
    if (!winnerResult.ok) return { ok: false, error: winnerResult.error, detail: winnerResult.detail };
    const [nextState, decision] = winnerResult.value;

    if ('speaker_type' in decision) {
      const resolvedLogPath = discussEventLogPath(ctx.sessionDir);
      const { nextSeq: resolvedSeq, watermark: resolvedWm } = prepareMutation(resolvedLogPath, 1);
      store.persistMutation(ctx.sessionDir, nextState, [{
        sessionId: nextState.session_id,
        topic: nextState.topic,
        projectRoot: store.projectRoot,
        seq: resolvedSeq,
        kind: 'round_resolved',
        ts: nowIsoString(),
        payload: { winner: decision.winner },
      }], resolvedWm);
      return { ok: true, value: { kind: 'resolved', winner: decision.winner } };
    }

    if (decision.reason === 'epoch_transition') {
      const epochLogPath = discussEventLogPath(ctx.sessionDir);
      const { nextSeq: epochSeq, watermark: epochWm } = prepareMutation(epochLogPath, 1);
      store.persistMutation(ctx.sessionDir, nextState, [{
        sessionId: nextState.session_id,
        topic: nextState.topic,
        projectRoot: store.projectRoot,
        seq: epochSeq,
        kind: 'round_resolved',
        ts: nowIsoString(),
        payload: { epoch: nextState.epoch },
      }], epochWm);
      return { ok: true, value: { kind: 'epoch_transition', epoch: nextState.epoch } };
    }

    const endedState = applyEnd(
      {
        ...nextState,
        end_reason_content: endContent(decision.reason),
      },
      {},
      nowIsoString(),
    );
    if (!endedState.ok) return { ok: false, error: endedState.error, detail: endedState.detail };
    const endAfterResolveLogPath = discussEventLogPath(ctx.sessionDir);
    const { nextSeq: endAfterResolveSeq, watermark: endAfterResolveWm } = prepareMutation(endAfterResolveLogPath, 1);
    store.persistMutation(ctx.sessionDir, endedState.value, [{
      sessionId: endedState.value.session_id,
      topic: endedState.value.topic,
      projectRoot: store.projectRoot,
      seq: endAfterResolveSeq,
      kind: 'session_ended',
      ts: nowIsoString(),
      payload: { reason: decision.reason },
    }], endAfterResolveWm);
    return { ok: true, value: { kind: 'ended', reason: decision.reason } };
  });
  if (!resolved.ok) return jsonResult({ error: resolved.error, ...(resolved.detail ?? {}) });

  switch (resolved.value.kind) {
    case 'resolved':
      return jsonResult({ status: 'bidding', phase: 'resolved', winner: resolved.value.winner });
    case 'epoch_transition':
      return jsonResult({ status: 'bidding', phase: 'epoch_transition', epoch: resolved.value.epoch });
    case 'ended':
      return jsonResult({ status: 'bidding', phase: 'ended', reason: resolved.value.reason });
  }
}

export async function handleStep(
  input: Extract<DiscussLeadOpInput, { op: '_3_step' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = store.resolveOrError(input.session);
  if (typeof sessionDir !== 'string') return sessionDir;

  const ctx: StepContext = {
    sessionDir,
    statePath: store.statePath(sessionDir),
    timeoutMs: input.timeout_seconds * 1000,
  };

  const state = await bootstrapFromSetup(ctx, store);
  if (!state.ok) return jsonResult({ error: state.error, ...(state.detail ?? {}) });

  switch (state.value.status) {
    case 'ended':
      return jsonResult({ status: 'ended', phase: 'ended', reason: 'already_ended' });
    case 'speaking':
      return stepSpeaking(ctx, input, store);
    case 'bidding':
      return stepBidding(ctx, store);
    default:
      return jsonResult({ status: 'setup', phase: 'not_ready' });
  }
}
