import { jsonResult, type McpResult } from '../shared/mcp-utils.js';
import type { EndReason, DiscussState, Result } from './types.js';
import type { DiscussLeadOpInput } from './schemas.js';
import { SessionStore } from './session-store.js';
import {
  startBidding,
  resolveWinner,
  applySpeechTimeout,
  applyExpel,
  applyEnd,
} from './state-machine.js';
import { allBidsIn, speechDelivered, noParticipants } from './conditions.js';
import { waitForCondition } from './wait.js';
import { resolveSession, nowIsoString, resultToMcp, loadState, endContent } from './handler-utils.js';

export async function handle3Step(
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

    if (state.min_bid_delay_ms > 0) {
      const allAgentsBid = (s: DiscussState) =>
        Object.entries(s.agents).every(([name, a]) => a.banned || s.current_bids[name] != null);
      await waitForCondition(statePath, allAgentsBid, state.min_bid_delay_ms);
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
