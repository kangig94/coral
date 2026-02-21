/**
 * Coral Discuss MCP Server — tool definitions and dispatch handlers.
 * Uses SessionStore + pure state-machine functions.
 */

import { textResult, jsonResult, type McpResult } from '../shared/mcp-utils.js';
import type { DiscussState, Result } from './types.js';
import { SessionStore } from './session-store.js';
import {
  initSession,
  startBidding,
  applyBid,
  resolveWinner,
  applySpeech,
  applyEpochSummary,
  applyEnd,
  DEFAULT_BID_THRESHOLD,
  DEFAULT_MAX_EPOCHS,
} from './state-machine.js';
import { allBidsIn, speechDelivered, actionNeeded } from './conditions.js';
import { waitForCondition } from './wait.js';
import { formatFull, formatRecent, formatSummary } from './transcript.js';
import { seedPersonas } from './persona-seed.js';
import { discussOpSchema, discussPersonaSeedSchema, type DiscussOpInput } from './schemas.js';

/** Resolve session directory or return a not-found error. */
function resolveSession(store: SessionStore, sessionId: string): string | McpResult {
  const dir = store.resolveDir(sessionId);
  return dir ?? jsonResult({ error: 'session_not_found' });
}

/**
 * Lock-load-apply-save pattern used by most mutating handlers.
 * Applies a state-machine function under lock, saves on success, returns Result.
 */
async function mutateSession<T>(
  store: SessionStore,
  sessionDir: string,
  apply: (state: DiscussState) => Result<DiscussState>,
  extract: (state: DiscussState) => T,
): Promise<Result<T>> {
  return store.withLock(sessionDir, async () => {
    const state = store.load(sessionDir);
    const res = apply(state);
    if (!res.ok) return res;
    store.save(sessionDir, res.value);
    return { ok: true as const, value: extract(res.value) };
  });
}

/** Convert a Result to an McpResult. */
function resultToMcp(result: Result<unknown>): McpResult {
  if (!result.ok) return jsonResult({ error: result.error, ...result.detail });
  return jsonResult(result.value as Record<string, unknown>);
}

/** Map discuss state status to action name for action_needed responses. */
const STATUS_TO_ACTION: Record<string, string> = {
  ended: 'session_ended',
  speaking: 'speak',
};

const WAIT_TIMEOUT_LIMITS: Record<string, number> = { all_bids: 60, speech_delivered: 120, action_needed: 180 };

function validateWaitConstraints(input: Extract<DiscussOpInput, { op: 'wait' }>): void {
  const limit = WAIT_TIMEOUT_LIMITS[input.condition] ?? 60;
  if (input.timeout_seconds > limit) throw new Error(`timeout_seconds exceeds ${limit}s limit for ${input.condition}`);
  if (input.condition === 'action_needed' && !input.agent_name) throw new Error('agent_name required for action_needed condition');
}

function validateEndConstraints(input: Extract<DiscussOpInput, { op: 'end' }>): void {
  if (input.force && !input.reason?.trim()) throw new Error('reason is required when force=true');
}

export const tools = [
  {
    name: 'discuss',
    description: 'Multi-agent discussion session management. Use op field to select operation: create (initialize session), bid (submit speaking desire 0-100), wait (block until condition), speak (record speech), transcript (read transcript), state (query state), end (finalize), epoch_summary (append summary).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: {
          type: 'string',
          enum: ['create', 'bid', 'wait', 'speak', 'transcript', 'state', 'end', 'epoch_summary'],
          description: 'Operation. create: topic+agents required. bid: session+agent_name+score. wait: session+condition+timeout_seconds. speak: session+agent_name+content. transcript: session required. state: session required. end: session required. epoch_summary: session+epoch+summary.',
        },
        session: { type: 'string', description: 'Session ID (required for all ops except create)' },
        agent_name: { type: 'string', description: 'Agent name' },
        topic: { type: 'string', description: 'Discussion topic (create)' },
        agents: {
          type: 'array',
          description: 'Agent list (create)',
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
        quota_per_epoch: { type: 'integer', description: 'Max speeches per agent per epoch (create, default 3)' },
        recent_turns: { type: 'integer', description: 'Recent turns in transcript (create, default 5)' },
        score: { type: 'integer', description: 'Desire score 0-100 (bid)', minimum: 0, maximum: 100 },
        condition: { type: 'string', enum: ['all_bids', 'speech_delivered', 'action_needed'], description: 'Wait condition' },
        timeout_seconds: { type: 'number', description: 'Max wait seconds (limits: all_bids=60, speech_delivered=120, action_needed=180)' },
        content: { type: 'string', description: 'Speech content (speak)' },
        mode: { type: 'string', enum: ['full', 'recent', 'summary'], description: 'Transcript mode (default: recent)' },
        last_n: { type: 'integer', description: 'Last N entries (transcript)', minimum: 1, maximum: 50 },
        synthesis: { type: 'string', description: 'Synthesis text (end)' },
        force: { type: 'boolean', description: 'Force-end (end)' },
        reason: { type: 'string', description: 'Force reason (end, required when force=true)' },
        epoch: { type: 'integer', description: 'Epoch number (epoch_summary)', minimum: 1 },
        summary: { type: 'string', description: 'Epoch summary text (epoch_summary)' },
      },
      required: ['op'],
    },
  },
  {
    name: 'discuss_persona_seed',
    description: 'Generate diverse persona position assignments using k-DPP sampling on controversy axes. Returns seed_used for reproducibility.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        controversy_axes: {
          type: 'array',
          description: 'Controversy axes with positions. Axis names must be unique. Positions within each axis must be unique.',
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
        n: { type: 'integer', description: 'Number of persona assignments (1-8)', minimum: 1, maximum: 8 },
        seed: { type: ['integer', 'null'], description: 'RNG seed for reproducibility. Null = random seed.' },
      },
      required: ['controversy_axes', 'n'],
    },
  },
];

async function handleDiscussOp(input: DiscussOpInput, store: SessionStore): Promise<McpResult> {
  switch (input.op) {
    case 'create': {
      store.cleanupExpiredSessions();
      const now = new Date().toISOString();
      const rawThreshold = parseInt(process.env.CORAL_DISCUSS_BID_THRESHOLD ?? '', 10);
      const bidThreshold = (Number.isFinite(rawThreshold) && rawThreshold >= 1 && rawThreshold <= 100)
        ? rawThreshold : DEFAULT_BID_THRESHOLD;
      const rawMaxEpochs = parseInt(process.env.CORAL_DISCUSS_MAX_EPOCHS ?? '', 10);
      const maxEpochs = (Number.isFinite(rawMaxEpochs) && rawMaxEpochs >= 1 && rawMaxEpochs <= 10)
        ? rawMaxEpochs : DEFAULT_MAX_EPOCHS;
      const state = initSession(input, now, bidThreshold, maxEpochs);
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
        session_dir: sessionDir,
        team_name: state.team_name,
        topic: input.topic,
        status: state.status,
        bid_threshold: state.bid_threshold,
        max_epochs: state.max_epochs,
        agents: input.agents.map((a) => a.name),
      });
    }

    case 'bid': {
      const sessionDir = resolveSession(store, input.session);
      if (typeof sessionDir !== 'string') return sessionDir;

      const result = await mutateSession(
        store,
        sessionDir,
        (s) => applyBid(s, input.agent_name, input.score, new Date().toISOString()),
        (s) => ({ all_bids_in: s.pending_bidders.length === 0 }),
      );
      return resultToMcp(result);
    }

    case 'wait': {
      const sessionDir = store.resolveDir(input.session);
      if (!sessionDir) return textResult('Error: session_not_found', true);

      // Agent membership pre-check for action_needed (avoids burning full timeout on unknown agent)
      if (input.condition === 'action_needed') {
        const preState = store.load(sessionDir);
        if (!preState.agents[input.agent_name!]) {
          return jsonResult({ error: 'agent_not_found', agent_name: input.agent_name });
        }
      }

      // Auto-start: transition setup -> bidding BEFORE the poll loop begins.
      // Without this, allBidsIn predicate never fires (it requires status=bidding).
      if (input.condition === 'all_bids') {
        await store.withLock(sessionDir, async () => {
          const s = store.load(sessionDir);
          if (s.status === 'setup') {
            const res = startBidding(s, new Date().toISOString());
            if (res.ok) store.save(sessionDir, res.value);
          }
        });
      }

      const predicates: Record<string, (s: DiscussState) => boolean> = {
        all_bids: allBidsIn,
        speech_delivered: speechDelivered,
        action_needed: actionNeeded(input.agent_name!),
      };
      const pred = predicates[input.condition];

      const statePath = store.statePath(sessionDir);
      const waitResult = await waitForCondition(statePath, pred, input.timeout_seconds * 1000);

      if (waitResult.error) {
        return textResult(`Error: ${waitResult.error}`, true);
      }

      // After error check, state is guaranteed non-null (discriminated union narrowing)
      const waitState = waitResult.state!;

      // Auto-resolve on all_bids fulfillment
      if (waitResult.fulfilled && input.condition === 'all_bids') {
        const outcome = await store.withLock(sessionDir, async () => {
          const state = store.load(sessionDir);
          // TOCTOU guard: re-check condition inside lock (stale wakeup detection)
          if (!allBidsIn(state)) {
            return { stale: true, status: state.status, step: state.step, epoch: state.epoch };
          }
          const res = resolveWinner(state, new Date().toISOString());
          if (!res.ok) return { error: res.error, ...res.detail };
          const [newState, resolveData] = res.value;
          store.save(sessionDir, newState);
          return resolveData as Record<string, unknown>;
        });
        return jsonResult({ fulfilled: true, elapsed_seconds: waitResult.elapsed_ms / 1000, ...outcome });
      }

      // Action-needed: tell agent what to do next (information veil: your_speaks, not quota_remaining)
      if (waitResult.fulfilled && input.condition === 'action_needed') {
        const action = STATUS_TO_ACTION[waitState.status] ?? 'bid';
        return jsonResult({
          fulfilled: true,
          action,
          elapsed_seconds: waitResult.elapsed_ms / 1000,
          epoch: waitState.epoch,
          your_speaks: waitState.agents[input.agent_name!]?.total_speaks ?? 0,
        });
      }

      // Generic return (speech_delivered or timeout)
      return jsonResult({
        fulfilled: waitResult.fulfilled,
        elapsed_seconds: waitResult.elapsed_ms / 1000,
        status: waitState.status,
        step: waitState.step,
        epoch: waitState.epoch,
      });
    }

    case 'speak': {
      const sessionDir = resolveSession(store, input.session);
      if (typeof sessionDir !== 'string') return sessionDir;

      const result = await mutateSession(
        store,
        sessionDir,
        (s) => applySpeech(s, input.agent_name, input.content, new Date().toISOString()),
        (s) => ({ step: s.step, status: s.status }),
      );
      return resultToMcp(result);
    }

    case 'transcript': {
      const sessionDir = resolveSession(store, input.session);
      if (typeof sessionDir !== 'string') return sessionDir;

      // When agent_name provided: track read under lock for bid enforcement.
      // When absent: lockless read (no tracking needed).
      const caller = input.agent_name;
      const state = caller
        ? await store.withLock(sessionDir, async () => {
            const s = store.load(sessionDir);
            if (s.agents[caller] && (s.transcript_read_step[caller] ?? 0) < s.step) {
              const ts = new Date().toISOString();
              const updated = {
                ...s,
                transcript_read_step: { ...s.transcript_read_step, [caller]: s.step },
                updated_at: ts,
                last_activity_at: ts,
              };
              store.save(sessionDir, updated);
              return updated;
            }
            return s;
          })
        : store.load(sessionDir);

      // Full-transcript ACL: mode=full requires agent_name=current_speaker OR status=ended
      if (input.mode === 'full' && state.status !== 'ended') {
        if (!caller) {
          return jsonResult({ error: 'full_transcript_requires_speaker_or_ended' });
        }
        if (caller !== state.current_speaker) {
          return jsonResult({ error: 'full_transcript_speaker_only' });
        }
      }

      let text: string;
      switch (input.mode) {
        case 'full':
          text = formatFull(state.transcript, state.agents);
          break;
        case 'summary':
          text = formatSummary(state.transcript, state.agents);
          break;
        default:
          text = formatRecent(state.transcript, input.last_n ?? state.recent_turns, state.agents);
      }
      return textResult(text);
    }

    case 'state': {
      const sessionDir = resolveSession(store, input.session);
      if (typeof sessionDir !== 'string') return sessionDir;

      const state = store.load(sessionDir);
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
        recent_turns: state.recent_turns,
        agents: Object.fromEntries(
          Object.entries(state.agents).map(([n, a]) => [
            n,
            { display_name: a.display_name, total_speaks: a.total_speaks },
          ]),
        ),
        pending_bidders: state.pending_bidders,
        total_agents: Object.keys(state.agents).length,
      });
    }

    case 'end': {
      const sessionDir = resolveSession(store, input.session);
      if (typeof sessionDir !== 'string') return sessionDir;

      const result = await mutateSession(
        store,
        sessionDir,
        (s) => applyEnd(s, { force: input.force, reason: input.reason, synthesis: input.synthesis }, new Date().toISOString()),
        () => ({ ok: true, session_id: input.session }),
      );
      return resultToMcp(result);
    }

    case 'epoch_summary': {
      const sessionDir = resolveSession(store, input.session);
      if (typeof sessionDir !== 'string') return sessionDir;

      const result = await mutateSession(
        store,
        sessionDir,
        (s) => applyEpochSummary(s, input.epoch, input.summary, new Date().toISOString()),
        () => ({ ok: true }),
      );
      return resultToMcp(result);
    }

    default: {
      const _exhaustive: never = input;
      return textResult(`Unhandled op: ${(_exhaustive as DiscussOpInput).op}`, true);
    }
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
        const parsed = discussOpSchema.safeParse(rawArgs);
        if (!parsed.success) {
          const rawOp = (rawArgs as Record<string, unknown>).op;
          if (rawOp !== undefined && parsed.error.issues.some((i) => i.code === 'invalid_union_discriminator')) {
            return jsonResult({ error: 'unknown_op', op: rawOp });
          }
          throw parsed.error;
        }
        const input = parsed.data;
        if (input.op === 'wait') validateWaitConstraints(input);
        if (input.op === 'end') validateEndConstraints(input);
        return handleDiscussOp(input, store);
      }

      case 'discuss_persona_seed': {
        const input = discussPersonaSeedSchema.parse(rawArgs);
        return resultToMcp(seedPersonas(input));
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
