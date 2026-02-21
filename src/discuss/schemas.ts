/**
 * Zod schemas for MCP tool input validation — discuss_* tools.
 */

import { z } from 'zod';
import { identPattern } from '../shared/mcp-utils.js';

/** Session ID: yymmdd-HHmm-xxxx (compact timestamp + 4-char random suffix). */
export const sessionIdPattern = /^[0-9]{6}-[0-9]{4}-[a-z0-9]{4}$/;

// discuss_create — Initialize a discussion session
export const discussCreateSchema = z.object({
  topic: z.string().min(1),
  agents: z
    .array(
      z.object({
        name: z.string().regex(identPattern, 'Agent name must be alphanumeric'),
        persona: z.string().min(1),
      }),
    )
    .min(2)
    .max(8)
    .refine(
      (agents) => new Set(agents.map((a) => a.name)).size === agents.length,
      'Agent names must be unique',
    ),
  quota_per_epoch: z.number().int().min(1).max(10).default(3),
  recent_turns: z.number().int().min(1).max(20).default(5),
});

// discuss_bid — Submit speaking desire score (0–100)
// Voting score guard (must be 0 or 1) is enforced in state-machine.ts:applyBid
export const discussBidSchema = z.object({
  session: z.string().regex(sessionIdPattern),
  agent_name: z.string().regex(identPattern),
  score: z.number().int().min(0).max(100),
});

// discuss_wait — Block until condition fulfilled or timeout
const WAIT_TIMEOUT_LIMITS: Record<string, number> = { all_bids: 60, speech_delivered: 120, action_needed: 180 };

export const discussWaitSchema = z
  .object({
    session: z.string().regex(sessionIdPattern),
    condition: z.enum(['all_bids', 'speech_delivered', 'action_needed']),
    timeout_seconds: z.number().min(1),
    agent_name: z.string().regex(identPattern).optional(),
  })
  .refine(
    (input) => input.timeout_seconds <= (WAIT_TIMEOUT_LIMITS[input.condition] ?? 60),
    (input) => ({ message: `timeout_seconds exceeds ${WAIT_TIMEOUT_LIMITS[input.condition]}s limit for ${input.condition}` }),
  )
  .refine(
    (input) => input.condition !== 'action_needed' || input.agent_name != null,
    { message: 'agent_name required for action_needed condition' },
  );

// discuss_speak — Record speech (only allowed if agent has floor)
export const discussSpeakSchema = z.object({
  session: z.string().regex(sessionIdPattern),
  agent_name: z.string().regex(identPattern),
  content: z.string().min(1),
});

// discuss_transcript — Read transcript
export const discussTranscriptSchema = z.object({
  session: z.string().regex(sessionIdPattern),
  agent_name: z.string().regex(identPattern).optional(),
  mode: z.enum(['full', 'recent', 'summary']).default('recent'),
  last_n: z.number().int().min(1).max(50).optional(),
});

// discuss_state — Query current state
export const discussStateSchema = z.object({
  session: z.string().regex(sessionIdPattern),
});

// discuss_end — Finalize discussion
export const discussEndSchema = z
  .object({
    session: z.string().regex(sessionIdPattern),
    synthesis: z.string().optional(),
    force: z.boolean().default(false),
    reason: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.force && !data.reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reason is required when force=true',
        path: ['reason'],
      });
    }
  });

// discuss_epoch_summary — Append epoch summary (teamlead-only, lock-protected)
export const discussEpochSummarySchema = z.object({
  session: z.string().regex(sessionIdPattern),
  epoch: z.number().int().min(1),
  summary: z.string().min(1),
});

export type DiscussCreateInput = z.infer<typeof discussCreateSchema>;
export type DiscussBidInput = z.infer<typeof discussBidSchema>;
export type DiscussWaitInput = z.infer<typeof discussWaitSchema>;
export type DiscussSpeakInput = z.infer<typeof discussSpeakSchema>;
export type DiscussTranscriptInput = z.infer<typeof discussTranscriptSchema>;
export type DiscussStateInput = z.infer<typeof discussStateSchema>;
export type DiscussEndInput = z.infer<typeof discussEndSchema>;
export type DiscussEpochSummaryInput = z.infer<typeof discussEpochSummarySchema>;
