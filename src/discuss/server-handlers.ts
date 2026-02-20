/**
 * Coral Discuss MCP Server — tool definitions and dispatch handlers.
 */

import { textResult, jsonResult, type McpResult } from '../shared/mcp-utils.js';
import { DiscussManager } from './discuss-manager.js';
import {
  discussCreateSchema,
  discussBidSchema,
  discussResolveSchema,
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
    name: 'discuss_resolve',
    description: 'Resolve current bidding to select next speaker. Returns winner, no_winner, vote_required, or end_vote.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session ID' },
        designate: { type: 'string', description: 'Forced speaker (cold_start only, all bids < 30)' },
      },
      required: ['session'],
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
    description: 'Query current session state. Never exposes bid scores (teamlead-only via discuss_resolve).',
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
  mgr: DiscussManager,
): Promise<McpResult> {
  try {
    switch (name) {
      case 'discuss_create': {
        const input = discussCreateSchema.parse(rawArgs);
        const result = await mgr.create(input);
        return jsonResult(result as Record<string, unknown>);
      }

      case 'discuss_bid': {
        const input = discussBidSchema.parse(rawArgs);
        const result = await mgr.submitBid(input.session, input.agent_name, input.score);
        return jsonResult(result as Record<string, unknown>);
      }

      case 'discuss_resolve': {
        const input = discussResolveSchema.parse(rawArgs);
        const result = await mgr.resolve(input.session, input.designate);
        return jsonResult(result as Record<string, unknown>);
      }

      case 'discuss_speak': {
        const input = discussSpeakSchema.parse(rawArgs);
        const result = await mgr.recordSpeech(input.session, input.agent_name, input.content);
        return jsonResult(result as Record<string, unknown>);
      }

      case 'discuss_transcript': {
        const input = discussTranscriptSchema.parse(rawArgs);
        // Access control: mode=full requires agent_name=current_speaker OR status=ended
        if (input.mode === 'full') {
          const state = mgr.getState(input.session);
          if ('error' in state) return jsonResult(state as Record<string, unknown>);
          const status = state.status as string;
          if (status !== 'ended') {
            if (!input.agent_name) {
              return jsonResult({ error: 'full_transcript_requires_speaker_or_ended' });
            }
            const currentSpeaker = state.current_speaker as string | null;
            if (input.agent_name !== currentSpeaker) {
              return jsonResult({ error: 'full_transcript_speaker_only' });
            }
          }
        }
        const result = mgr.getTranscript(input.session, input.mode, input.last_n);
        if (typeof result === 'object' && 'error' in result) {
          return jsonResult(result as Record<string, unknown>);
        }
        return textResult(result as string);
      }

      case 'discuss_state': {
        const input = discussStateSchema.parse(rawArgs);
        const result = mgr.getState(input.session);
        return jsonResult(result as Record<string, unknown>);
      }

      case 'discuss_end': {
        const input = discussEndSchema.parse(rawArgs);
        const result = await mgr.end(input.session, {
          force: input.force,
          reason: input.reason,
          synthesis: input.synthesis,
        });
        return jsonResult(result as Record<string, unknown>);
      }

      case 'discuss_epoch_summary': {
        const input = discussEpochSummarySchema.parse(rawArgs);
        const result = await mgr.recordEpochSummary(input.session, input.epoch, input.summary);
        return jsonResult(result as Record<string, unknown>);
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
