import { jsonResult, type McpResult } from '../shared/mcp-utils.js';
import type { DiscussState, Result } from './types.js';
import type { DiscussAgentOpInput } from './schemas.js';
import type { SessionStore } from './session-store.js';
import { applyBid, applySpeech, resolveAgentName } from './state-machine.js';
import { isWinner, bidReleased, setupComplete } from './conditions.js';
import { waitForCondition, INFINITE_POLL } from './wait.js';
import { formatFull } from './transcript.js';
import { resolveSession, nowIsoString, resultToMcp, loadState } from './handler-utils.js';

async function handleBid(
  input: Extract<DiscussAgentOpInput, { op: 'bid' }>,
  store: SessionStore,
): Promise<McpResult> {
  const sessionDir = resolveSession(store, input.session);
  if (typeof sessionDir !== 'string') return sessionDir;
  const statePath = store.statePath(sessionDir);
  const bidFinalResult = (state: DiscussState, resolved: string): McpResult => {
    const agentState = state.agents[resolved];
    if (agentState?.banned) {
      return jsonResult({ action: 'session_ended', reason: 'banned' });
    }
    if (state.status === 'ended') {
      return jsonResult({ action: 'session_ended', reason: 'already_ended', content: state.end_reason_content });
    }
    if (isWinner(resolved)(state)) {
      return jsonResult({ action: 'speak', transcript: formatFull(state.transcript, state.agents) });
    }
    const last = state.transcript.at(-1);
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
  };

  type BidPre =
    | { kind: 'banned'; state: DiscussState; resolved: string }
    | { kind: 'ended'; state: DiscussState; resolved: string }
    | { kind: 'setup' }
    | { kind: 'speaking' }
    | { kind: 'bidding'; resolved: string };
  type BidRecordResult = Result<{ step: number }>;

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
          const result = applyBid(state, resolved, input.score, input.thought, nowIsoString());
          if (!result.ok) {
            return { ok: false, error: result.error, detail: result.detail };
          }
          store.save(sessionDir, result.value);
          return { ok: true, value: { step: result.value.step } };
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
        return bidFinalResult(finalState, resolved);
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
  const applied = await store.withLock<Result<{ status: string; step: number }>>(sessionDir, async () => {
    const state = store.load(sessionDir);
    const resolved = resolveAgentName(state.agents, input.agent_name);
    if (!resolved) {
      return { ok: false, error: 'agent_not_found', detail: { agent_name: input.agent_name } };
    }
    const result = applySpeech(state, resolved, input.content, nowIsoString());
    if (!result.ok) {
      return { ok: false, error: result.error, detail: result.detail };
    }
    store.save(sessionDir, result.value);
    return {
      ok: true,
      value: {
        status: result.value.status,
        step: result.value.step,
      },
    };
  });

  return resultToMcp(applied);
}

export async function handleAgentOp(input: DiscussAgentOpInput, store: SessionStore): Promise<McpResult> {
  if (input.op === 'bid') return handleBid(input, store);
  return handleSpeak(input, store);
}
