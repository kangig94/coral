import { describe, expect, it } from 'vitest';

import {
  makeEvent,
  type DiscussDomainEvent,
  type PersistedDiscussSnapshot,
} from '../events.js';
import {
  makeEmptySnapshot,
  reduceDiscussEvent,
  replayDiscussEvents,
} from '../reducer.js';
import {
  decideBid,
  decideBidRoundClose,
  decideSessionCreate,
  decideSpeech,
  type SessionCreateOptions,
} from '../state-machine.js';
import type { DiscussCreateInput, DiscussState, Result } from '../types.js';

const NOW = '2026-03-11T00:00:00.000Z';
const PROJECT_ROOT = '/tmp/project';
const SESSION_ID = 'session-1';

function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.error);
}

function applyEvents(
  snapshot: PersistedDiscussSnapshot,
  events: DiscussDomainEvent[],
): PersistedDiscussSnapshot {
  return events.reduce((current, event) => reduceDiscussEvent(current, event), snapshot);
}

function replay(
  snapshot: PersistedDiscussSnapshot | undefined,
  events: DiscussDomainEvent[],
): PersistedDiscussSnapshot {
  return replayDiscussEvents(events, snapshot);
}

function nextSeq(snapshot: PersistedDiscussSnapshot): number {
  return snapshot.lastAppliedSeq + 1;
}

function makeInput(
  agents: DiscussCreateInput['agents'],
  minBidDelayMs = 0,
): DiscussCreateInput {
  return {
    topic: 'Should the city pedestrianize the downtown core?',
    agents,
    min_bid_delay_ms: minBidDelayMs,
  };
}

function createSnapshot(
  input: DiscussCreateInput,
  agentExecution?: SessionCreateOptions['agentExecution'],
): PersistedDiscussSnapshot {
  return replayDiscussEvents(unwrap(decideSessionCreate(
    input,
    SESSION_ID,
    PROJECT_ROOT,
    input.topic,
    1,
    NOW,
    agentExecution ? { agentExecution } : {},
  )));
}

describe('reducer projections', () => {
  it('matches incremental reduce and tail replay for a creation -> bid -> speech cycle', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'observer' },
    ]);

    const history: DiscussDomainEvent[] = [];
    let snapshot = makeEmptySnapshot(SESSION_ID, PROJECT_ROOT);

    const created = unwrap(decideSessionCreate(
      input,
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      1,
      NOW,
    ));
    history.push(...created);
    snapshot = replay(snapshot, created);

    const alphaBid = unwrap(decideBid(
      snapshot.state,
      'alpha',
      10,
      'I can go later.',
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      nextSeq(snapshot),
      NOW,
    ));
    history.push(...alphaBid);
    snapshot = replay(snapshot, alphaBid);

    const betaBid = unwrap(decideBid(
      snapshot.state,
      'beta',
      20,
      'I should break the tie now.',
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      nextSeq(snapshot),
      NOW,
    ));
    history.push(...betaBid);
    snapshot = replay(snapshot, betaBid);

    const closed = unwrap(decideBidRoundClose(
      snapshot.state,
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      nextSeq(snapshot),
      NOW,
    ));
    history.push(...closed);
    snapshot = replay(snapshot, closed);

    const speech = unwrap(decideSpeech(
      snapshot.state,
      'beta',
      'I will open the discussion.',
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      nextSeq(snapshot),
      NOW,
    ));
    history.push(...speech);

    const fullReplay = replay(undefined, history);
    const incremental = applyEvents(makeEmptySnapshot(SESSION_ID, PROJECT_ROOT), history);
    const tailReplay = replay(replay(undefined, history.slice(0, 4)), history.slice(4));

    expect(incremental).toEqual(fullReplay);
    expect(tailReplay).toEqual(fullReplay);
    expect(fullReplay.state.status).toBe('bidding');
    expect(fullReplay.state.step).toBe(2);
    expect(fullReplay.state.last_speech_step).toBe(1);
    expect(fullReplay.state.current_speaker).toBeNull();
    expect(fullReplay.state.agents.beta.total_speaks).toBe(1);
    expect(fullReplay.runtime.controlPhase).toBe('idle');
  });

  it('ends the session and enters synthesize control for a terminal no-winner batch', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    let snapshot = createSnapshot(input);
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state,
        cold_start: false,
      },
    };

    snapshot = replay(snapshot, unwrap(decideBid(
      snapshot.state,
      'alpha',
      10,
      'Not enough urgency.',
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      nextSeq(snapshot),
      NOW,
    )));
    snapshot = replay(snapshot, unwrap(decideBid(
      snapshot.state,
      'beta',
      20,
      'Still below threshold.',
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      nextSeq(snapshot),
      NOW,
    )));

    const terminalBatch = unwrap(decideBidRoundClose(
      snapshot.state,
      SESSION_ID,
      PROJECT_ROOT,
      input.topic,
      nextSeq(snapshot),
      NOW,
    ));
    const ended = replay(snapshot, terminalBatch);

    expect(terminalBatch.map((event) => event.kind)).toEqual(['bid.round.closed', 'session.ended']);
    expect(ended.state.status).toBe('ended');
    expect(ended.state.end_reason_content).toBe('All participants bid below the threshold. Ending discussion.');
    expect(ended.runtime.controlPhase).toBe('synthesize');
    expect(ended.lastAppliedSeq).toBe(snapshot.lastAppliedSeq + 2);
  });

  it('projects epoch_transition into evaluate_epoch runtime control', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'beta', persona: 'Beta', participation: 'required' },
    ]);
    const baseSnapshot = createSnapshot(input);
    const biddingState: DiscussState = {
      ...baseSnapshot.state,
      cold_start: false,
      current_bids: { alpha: 90, beta: 85 },
      current_thoughts: { alpha: 'I am blocked by quota.', beta: 'Same here.' },
      pending_bidders: [],
      agents: {
        alpha: {
          ...baseSnapshot.state.agents.alpha,
          quota_remaining: 0,
          fallback_used: true,
        },
        beta: {
          ...baseSnapshot.state.agents.beta,
          quota_remaining: 0,
          fallback_used: true,
        },
      },
    };

    const snapshot = replay(
      {
        ...baseSnapshot,
        state: biddingState,
      },
      unwrap(decideBidRoundClose(
        biddingState,
        SESSION_ID,
        PROJECT_ROOT,
        input.topic,
        3,
        NOW,
      )),
    );

    expect(snapshot.state.status).toBe('bidding');
    expect(snapshot.state.epoch).toBe(2);
    expect(snapshot.state.step).toBe(2);
    expect(snapshot.state.epoch_summary_written).toBeNull();
    expect(snapshot.runtime.controlPhase).toBe('evaluate_epoch');
  });

  it('seeds and updates persisted agent run retry fields from runtime events', () => {
    const input = makeInput([
      { name: 'alpha', persona: 'Alpha', participation: 'required' },
      { name: 'user', persona: 'User', participation: 'observer' },
    ]);
    const created = createSnapshot(input, {
      alpha: { manual: false, provider: 'codex', model: 'gpt-5' },
      user: { manual: true },
    });

    const afterBound = replayDiscussEvents([
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 3, 'agent.run.bound', NOW, {
        agent: 'alpha',
        executionSessionId: 'exec-1',
      }),
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 4, 'agent.job.started', NOW, {
        agent: 'alpha',
        jobId: 'job-1',
        purpose: 'bid',
        attempt: 2,
      }),
      makeEvent(SESSION_ID, PROJECT_ROOT, input.topic, 5, 'agent.job.finished', NOW, {
        agent: 'alpha',
        jobId: 'job-1',
        outcome: 'retryable_parse_error',
        attempt: 2,
      }),
    ], created);

    expect(created.runtime.agentRuns).toEqual({
      alpha: {
        provider: 'codex',
        model: 'gpt-5',
      },
    });
    expect(afterBound.runtime.agentRuns.alpha).toEqual({
      provider: 'codex',
      model: 'gpt-5',
      executionSessionId: 'exec-1',
      currentJobId: undefined,
      currentJobPurpose: undefined,
      currentAttempt: 2,
      lastAttemptOutcome: 'retryable_parse_error',
    });
  });
});
