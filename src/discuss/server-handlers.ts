/**
 * Coral Discuss MCP Server — tool definitions and dispatch handlers (v2).
 * Uses SessionStore + pure state-machine functions. discuss_resolve removed.
 */

import { textResult, jsonResult, type McpResult } from '../shared/mcp-utils.js';
import type { DiscussState } from './types.js';
import { SessionStore } from './session-store.js';
import {
  initSession,
  applyBid,
  resolveWinner,
  applySpeech,
  applyEpochSummary,
  applyEnd,
} from './state-machine.js';
import { allBidsIn, speechDelivered, actionNeeded } from './conditions.js';
import { waitForCondition } from './wait.js';
import { formatFull, formatRecent, formatSummary } from './transcript.js';
import {
  discussCreateSchema,
  discussBidSchema,
  discussWaitSchema,
  discussSpeakSchema,
  discussTranscriptSchema,
  discussStateSchema,
  discussEndSchema,
  discussEpochSummarySchema,
} from './schemas.js';

export { textResult, jsonResult };

export const tools = [
  {
    name: 'discuss_create',
    description: 'Initialize a new discussion session with agent personas and return session_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Discussion topic' },
        agents: {
          type: 'array',
          description: 'List of agents (2–8). Each has name (ASCII identifier) and persona text.',
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
        quota_per_epoch: { type: 'integer', description: 'Max speeches per agent per epoch (default 3)', default: 3 },
        recent_turns: { type: 'integer', description: 'Recent turns shown in transcript (default 5)', default: 5 },
      },
      required: ['topic', 'agents'],
    },
  },
  {
    name: 'discuss_bid',
    description: 'Submit speaking desire score 0–100. In voting mode: 0=agree to end, 1=disagree.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
        agent_name: { type: 'string', description: 'Agent name' },
        score: { type: 'integer', description: 'Desire score 0–100 (voting: 0=agree, 1=disagree)', minimum: 0, maximum: 100 },
      },
      required: ['session', 'agent_name', 'score'],
    },
  },
  {
    name: 'discuss_wait',
    description: 'Block until condition fulfilled. all_bids: auto-resolves when all bids in. speech_delivered: waits for current speech to finish. action_needed: waits for this agent\'s turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
        condition: { type: 'string', enum: ['all_bids', 'speech_delivered', 'action_needed'], description: 'Condition to wait for' },
        timeout_seconds: { type: 'number', description: 'Max wait: all_bids=60, speech_delivered=120, action_needed=180' },
        agent_name: { type: 'string', description: 'Required for action_needed condition' },
      },
      required: ['session', 'condition', 'timeout_seconds'],
    },
  },
  {
    name: 'discuss_speak',
    description: 'Record speech. Only allowed for the current speaker (current_speaker must match agent_name).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
        agent_name: { type: 'string', description: 'Speaking agent name' },
        content: { type: 'string', description: 'Speech content' },
      },
      required: ['session', 'agent_name', 'content'],
    },
  },
  {
    name: 'discuss_transcript',
    description: 'Read transcript. mode=full restricted to current speaker or when status=ended.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
        agent_name: { type: 'string', description: 'Caller agent name (required for full mode unless ended)' },
        mode: { type: 'string', enum: ['full', 'recent', 'summary'], default: 'recent' },
        last_n: { type: 'integer', description: 'Number of recent speeches to show in full (overrides recent_turns)', minimum: 1, maximum: 50 },
      },
      required: ['session'],
    },
  },
  {
    name: 'discuss_state',
    description: 'Query current session state. Bid scores only visible via discuss_wait("all_bids") auto-resolve.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
      },
      required: ['session'],
    },
  },
  {
    name: 'discuss_end',
    description: 'Finalize the discussion. Requires force=true+reason when ending during active speech or non-unanimous vote.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
        synthesis: { type: 'string', description: 'Optional synthesis/conclusion text' },
        force: { type: 'boolean', description: 'Force-end during speaking or voting', default: false },
        reason: { type: 'string', description: 'Required when force=true' },
      },
      required: ['session'],
    },
  },
  {
    name: 'discuss_epoch_summary',
    description: 'Append epoch summary to transcript. Teamlead-only. One per epoch, must match current epoch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
        epoch: { type: 'integer', description: 'Epoch number (must match current epoch)', minimum: 1 },
        summary: { type: 'string', description: 'Summary of the completed epoch' },
      },
      required: ['session', 'epoch', 'summary'],
    },
  },
];

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
  store: SessionStore,
): Promise<McpResult> {
  try {
    switch (name) {
      case 'discuss_create': {
        const input = discussCreateSchema.parse(rawArgs);
        const now = new Date().toISOString();
        const state = initSession(input, now);
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
          agents: input.agents.map((a) => a.name),
        });
      }

      case 'discuss_bid': {
        const input = discussBidSchema.parse(rawArgs);
        const sessionDir = store.resolveDir(input.session);
        if (!sessionDir) return jsonResult({ error: 'session_not_found' });

        const result = await store.withLock(sessionDir, async () => {
          const state = store.load(sessionDir);
          const res = applyBid(state, input.agent_name, input.score, new Date().toISOString());
          if (!res.ok) return res;
          store.save(sessionDir, res.value);
          return { ok: true as const, value: { all_bids_in: res.value.pending_bidders.length === 0 } };
        });

        if (!result.ok) return jsonResult({ error: result.error, ...result.detail });
        return jsonResult(result.value as Record<string, unknown>);
      }

      case 'discuss_wait': {
        const input = discussWaitSchema.parse(rawArgs);
        const sessionDir = store.resolveDir(input.session);
        if (!sessionDir) return textResult('Error: session_not_found', true);

        // Agent membership pre-check for action_needed (avoids burning full timeout on unknown agent)
        if (input.condition === 'action_needed') {
          const preState = store.load(sessionDir);
          if (!preState.agents[input.agent_name!]) {
            return jsonResult({ error: 'agent_not_found', agent_name: input.agent_name });
          }
        }

        let pred: (s: DiscussState) => boolean;
        if (input.condition === 'all_bids') {
          pred = allBidsIn;
        } else if (input.condition === 'speech_delivered') {
          pred = speechDelivered;
        } else {
          pred = actionNeeded(input.agent_name!);
        }

        const statePath = store.statePath(sessionDir);
        const waitResult = await waitForCondition(statePath, pred, input.timeout_seconds * 1000);

        // Error guard: no valid state was ever read
        if (waitResult.error) {
          return textResult(`Error: ${waitResult.error}`, true);
        }

        // Auto-resolve on all_bids fulfillment
        if (waitResult.fulfilled && input.condition === 'all_bids') {
          const outcome = await store.withLock(sessionDir, async () => {
            const state = store.load(sessionDir);
            // TOCTOU guard: re-check FULL condition inside lock (stale wakeup detection)
            if (!allBidsIn(state)) {
              return { stale: true, status: state.status, step: state.step, epoch: state.epoch };
            }
            const now = new Date().toISOString();
            const res = resolveWinner(state, now);
            if (!res.ok) return { error: res.error, ...res.detail };
            const [newState, resolveData] = res.value;
            store.save(sessionDir, newState);
            // Unwrap Result envelope — return ResolveResult directly to MCP
            return resolveData as Record<string, unknown>;
          });
          return jsonResult({ fulfilled: true, elapsed_seconds: waitResult.elapsed_ms / 1000, ...outcome });
        }

        // Action-needed: tell agent what to do next
        if (waitResult.fulfilled && input.condition === 'action_needed') {
          const s = waitResult.state;
          let action: string;
          if (s.status === 'speaking') action = 'speak';
          else if (s.status === 'voting') action = 'vote';
          else action = 'bid';
          return jsonResult({ fulfilled: true, action, elapsed_seconds: waitResult.elapsed_ms / 1000 });
        }

        // Generic return (speech_delivered or timeout)
        return jsonResult({
          fulfilled: waitResult.fulfilled,
          elapsed_seconds: waitResult.elapsed_ms / 1000,
          status: waitResult.state.status,
          step: waitResult.state.step,
          epoch: waitResult.state.epoch,
        });
      }

      case 'discuss_speak': {
        const input = discussSpeakSchema.parse(rawArgs);
        const sessionDir = store.resolveDir(input.session);
        if (!sessionDir) return jsonResult({ error: 'session_not_found' });

        const result = await store.withLock(sessionDir, async () => {
          const state = store.load(sessionDir);
          const res = applySpeech(state, input.agent_name, input.content, new Date().toISOString());
          if (!res.ok) return res;
          store.save(sessionDir, res.value);
          return { ok: true as const, value: { step: res.value.step, status: res.value.status } };
        });

        if (!result.ok) return jsonResult({ error: result.error, ...result.detail });
        return jsonResult(result.value as Record<string, unknown>);
      }

      case 'discuss_transcript': {
        const input = discussTranscriptSchema.parse(rawArgs);
        const sessionDir = store.resolveDir(input.session);
        if (!sessionDir) return jsonResult({ error: 'session_not_found' });

        const state = store.load(sessionDir);

        // Full-transcript ACL: mode=full requires agent_name=current_speaker OR status=ended
        if (input.mode === 'full') {
          if (state.status !== 'ended') {
            if (!input.agent_name) {
              return jsonResult({ error: 'full_transcript_requires_speaker_or_ended' });
            }
            if (input.agent_name !== state.current_speaker) {
              return jsonResult({ error: 'full_transcript_speaker_only' });
            }
          }
        }

        let text: string;
        if (input.mode === 'full') {
          text = formatFull(state.transcript, state.agents);
        } else if (input.mode === 'summary') {
          text = formatSummary(state.transcript, state.agents);
        } else {
          const lastN = input.last_n ?? state.recent_turns;
          text = formatRecent(state.transcript, lastN, state.agents);
        }
        return textResult(text);
      }

      case 'discuss_state': {
        const input = discussStateSchema.parse(rawArgs);
        const sessionDir = store.resolveDir(input.session);
        if (!sessionDir) return jsonResult({ error: 'session_not_found' });

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
          quota_per_epoch: state.quota_per_epoch,
          recent_turns: state.recent_turns,
          agents: Object.fromEntries(
            Object.entries(state.agents).map(([n, a]) => [
              n,
              { display_name: a.display_name, quota_remaining: a.quota_remaining, total_speaks: a.total_speaks, fallback_used: a.fallback_used },
            ]),
          ),
          pending_bidders: state.pending_bidders,
          eligible_count: Object.values(state.agents).filter((a) => a.quota_remaining > 0).length,
          total_agents: Object.keys(state.agents).length,
        });
      }

      case 'discuss_end': {
        const input = discussEndSchema.parse(rawArgs);
        const sessionDir = store.resolveDir(input.session);
        if (!sessionDir) return jsonResult({ error: 'session_not_found' });

        const result = await store.withLock(sessionDir, async () => {
          const state = store.load(sessionDir);
          const res = applyEnd(state, { force: input.force, reason: input.reason, synthesis: input.synthesis }, new Date().toISOString());
          if (!res.ok) return res;
          store.save(sessionDir, res.value);
          return { ok: true as const, value: { ok: true, session_id: input.session } };
        });

        if (!result.ok) return jsonResult({ error: result.error, ...result.detail });
        return jsonResult(result.value as Record<string, unknown>);
      }

      case 'discuss_epoch_summary': {
        const input = discussEpochSummarySchema.parse(rawArgs);
        const sessionDir = store.resolveDir(input.session);
        if (!sessionDir) return jsonResult({ error: 'session_not_found' });

        const result = await store.withLock(sessionDir, async () => {
          const state = store.load(sessionDir);
          const res = applyEpochSummary(state, input.epoch, input.summary, new Date().toISOString());
          if (!res.ok) return res;
          store.save(sessionDir, res.value);
          return { ok: true as const, value: { ok: true } };
        });

        if (!result.ok) return jsonResult({ error: result.error, ...result.detail });
        return jsonResult(result.value as Record<string, unknown>);
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
