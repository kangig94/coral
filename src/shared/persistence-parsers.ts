import { z } from 'zod';
import { type DiscussDomainEvent, type PersistedDiscussSnapshot, controlPhases } from '../discuss/events.js';
import {
  discussStatuses,
  participationTypes,
  resolveReasons,
  sessionEventKinds,
  speakerTypes,
  transcriptResolveTypes,
} from '../discuss/types.js';
import type {
  DiscussDiscoveryData,
  DiscussSummaryIndexData,
} from './persistence-types.js';
import { jobPhaseSchema, terminalResultSchema, type JobStatusRecord } from './types.js';

const finiteNumberSchema = z.number().finite();
const integerSchema = z.number().int();
const nonNegativeIntegerSchema = integerSchema.min(0);
const positiveIntegerSchema = integerSchema.min(1);
const stringArraySchema = z.array(z.string());
const discussStatusSchema = z.enum(discussStatuses);
const participationSchema = z.enum(participationTypes);
const speakerTypeSchema = z.enum(speakerTypes);
const transcriptResolveTypeSchema = z.enum(transcriptResolveTypes);
const transcriptEventSchema = z.enum(sessionEventKinds);
const controlPhaseSchema = z.enum(controlPhases);
const resolveReasonSchema = z.enum(resolveReasons);

export const persistedStatusRecordSchema = z
  .object({
    jobId: z.string(),
    sessionId: z.string(),
    provider: z.string(),
    projectRoot: z.string(),
    backendNamespace: z.string().optional(),
    bundleHash: z.string().optional(),
    jobKind: z.enum(['provider', 'workflow']).optional(),
    phase: jobPhaseSchema,
    launch: z
      .object({
        state: z.enum(['pending', 'queued', 'ready', 'busy', 'error']),
        message: z.string().optional(),
        updatedAt: z.string(),
      })
      .passthrough(),
    result: terminalResultSchema.optional(),
  })
  .passthrough();

export function parseJobStatusRecord(value: unknown): JobStatusRecord | null {
  return parseWithSchema(persistedStatusRecordSchema, value) as JobStatusRecord | null;
}

export function safeParseJobStatusRecord(value: unknown) {
  return persistedStatusRecordSchema.safeParse(value);
}

function recordLikeSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.union([z.record(z.string(), valueSchema), z.array(valueSchema)]);
}

export function parseWithSchema<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.output<TSchema> | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseStringArray(value: unknown): string[] | null {
  return parseWithSchema(stringArraySchema, value);
}

const unknownRecordLikeSchema = recordLikeSchema(z.unknown());
const stringRecordLikeSchema = recordLikeSchema(z.string());
const booleanRecordLikeSchema = recordLikeSchema(z.boolean());
const numberRecordLikeSchema = recordLikeSchema(finiteNumberSchema);
const nullableNumberRecordLikeSchema = recordLikeSchema(z.union([finiteNumberSchema, z.null()]));

const discussAgentStateSchema = z
  .object({
    persona: z.string(),
    display_name: z.string(),
    participation: participationSchema,
    quota_remaining: finiteNumberSchema,
    total_speaks: finiteNumberSchema,
    fallback_used: z.boolean(),
    banned: z.boolean(),
  })
  .passthrough();

const transcriptEntrySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bids'),
      step: finiteNumberSchema,
      epoch: finiteNumberSchema,
      ts: z.string(),
      bids: numberRecordLikeSchema,
      effective_bids: numberRecordLikeSchema.optional(),
      thoughts: stringRecordLikeSchema.optional(),
      winner: z.union([z.string(), z.null()]),
      resolve_type: transcriptResolveTypeSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('speech'),
      step: finiteNumberSchema,
      epoch: finiteNumberSchema,
      ts: z.string(),
      agent: z.string(),
      display_name: z.string(),
      content: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('follow_up'),
      epoch: finiteNumberSchema,
      ts: z.string(),
      agent: z.string(),
      question: z.string(),
      answer: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('epoch_summary'),
      epoch: finiteNumberSchema,
      ts: z.string(),
      summary: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('session_event'),
      epoch: finiteNumberSchema,
      ts: z.string(),
      event: transcriptEventSchema,
      detail: z.string(),
    })
    .passthrough(),
]);

const sessionCreatedInputSchema = z
  .object({
    topic: z.string(),
    min_bid_delay_ms: finiteNumberSchema,
    agents: z.array(
      z
        .object({
          name: z.string(),
          persona: z.string(),
          participation: participationSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();

const sessionCreatedConfigSchema = z
  .object({
    bidThreshold: finiteNumberSchema,
    maxEpochs: finiteNumberSchema,
    quotaPerEpoch: finiteNumberSchema,
  })
  .passthrough();

const sessionCreatedAgentExecutionSchema = z.union([
  z
    .object({
      manual: z.literal(true),
      provider: z.undefined().optional(),
      model: z.undefined().optional(),
    })
    .passthrough(),
  z
    .object({
      manual: z.literal(false),
      provider: z.string(),
      model: z.string(),
    })
    .passthrough(),
]);

const followUpQueueItemSchema = z
  .object({
    agent: z.string(),
    question: z.string(),
  })
  .passthrough();

const bidRoundClosedOutcomeSchema = z.union([
  z
    .object({
      winner: z.string(),
      speaker_type: speakerTypeSchema,
    })
    .passthrough(),
  z
    .object({
      no_winner: z.literal(true),
      reason: resolveReasonSchema,
    })
    .passthrough(),
]);

const bidRoundClosedStateMutationsSchema = z
  .object({
    cold_start: z.boolean().optional(),
    fallback_used: booleanRecordLikeSchema.optional(),
    quota_remaining: numberRecordLikeSchema.optional(),
    epoch: finiteNumberSchema.optional(),
  })
  .passthrough();

function createDiscussEventSchema<K extends DiscussDomainEvent['kind']>(kind: K, payloadSchema: z.ZodTypeAny) {
  return z
    .object({
      v: z.literal(1),
      sessionId: z.string(),
      projectRoot: z.string(),
      topic: z.string(),
      seq: positiveIntegerSchema,
      kind: z.literal(kind),
      ts: z.string(),
      payload: payloadSchema,
    })
    .passthrough();
}

export const discussDomainEventSchema = z.discriminatedUnion('kind', [
  createDiscussEventSchema(
    'session.created',
    z
      .object({
        input: sessionCreatedInputSchema,
        config: sessionCreatedConfigSchema,
        agentExecution: recordLikeSchema(sessionCreatedAgentExecutionSchema),
      })
      .passthrough(),
  ),
  createDiscussEventSchema('bidding.opened', unknownRecordLikeSchema),
  createDiscussEventSchema(
    'bid.submitted',
    z
      .object({
        agent: z.string(),
        score: finiteNumberSchema,
        thought: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'participants.expelled',
    z
      .object({
        agents: stringArraySchema,
        isRespawn: z.boolean(),
        hint: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'bid.round.closed',
    z
      .object({
        allBids: numberRecordLikeSchema,
        effectiveBids: numberRecordLikeSchema,
        thoughts: stringRecordLikeSchema,
        outcome: bidRoundClosedOutcomeSchema,
        stateMutations: bidRoundClosedStateMutationsSchema,
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'speech.recorded',
    z
      .object({
        agent: z.string(),
        content: z.string(),
        decrementQuota: z.boolean(),
        recordLastSpeechStep: integerSchema.optional(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'speech.timed_out',
    z
      .object({
        agent: z.string(),
        content: z.string(),
        decrementQuota: z.boolean(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'epoch.summary.recorded',
    z
      .object({
        summary: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'must_answer.carry_forward.set',
    z
      .object({
        items: stringArraySchema,
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'follow_up.queue.set',
    z
      .object({
        queue: z.array(followUpQueueItemSchema),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'follow_up.answered',
    z
      .object({
        agent: z.string(),
        question: z.string(),
        answer: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'session.ended',
    z
      .object({
        endReason: z.string().optional(),
        endReasonContent: z.union([z.string(), z.null()]).optional(),
        force: z.boolean().optional(),
        reason: z.string().optional(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'session.synthesized',
    z
      .object({
        synthesis: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'agent.run.bound',
    z
      .object({
        agent: z.string(),
        executionSessionId: z.string(),
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'agent.job.started',
    z
      .object({
        agent: z.string(),
        jobId: z.string(),
        purpose: z.string(),
        attempt: integerSchema,
      })
      .passthrough(),
  ),
  createDiscussEventSchema(
    'agent.job.finished',
    z
      .object({
        agent: z.string(),
        jobId: z.string(),
        outcome: z.string(),
        attempt: integerSchema,
      })
      .passthrough(),
  ),
]);

const persistedDiscussAgentRunSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    executionSessionId: z.string().optional(),
    currentJobId: z.string().optional(),
    currentJobPurpose: z.string().optional(),
    currentAttempt: integerSchema.optional(),
    lastAttemptOutcome: z.string().optional(),
  })
  .passthrough();

const persistedDiscussRuntimeSchema = z
  .object({
    controlPhase: controlPhaseSchema,
    carryForwardMustAnswer: stringArraySchema,
    followUpQueue: z.array(followUpQueueItemSchema),
    agentRuns: recordLikeSchema(persistedDiscussAgentRunSchema),
  })
  .passthrough();

const persistedDiscussStateSchema = z
  .object({
    session_id: z.string(),
    topic: z.string(),
    status: discussStatusSchema,
    step: integerSchema,
    epoch: integerSchema,
    max_epochs: integerSchema,
    quota_per_epoch: finiteNumberSchema,
    cold_start: z.boolean(),
    agents: recordLikeSchema(discussAgentStateSchema),
    current_bids: nullableNumberRecordLikeSchema,
    current_thoughts: stringRecordLikeSchema,
    pending_bidders: stringArraySchema,
    current_speaker: z.union([z.string(), z.null()]),
    speaker_type: z.union([speakerTypeSchema, z.null()]),
    epoch_summary_written: z.union([integerSchema, z.null()]),
    created_at: z.string(),
    last_activity_at: z.string(),
    last_speech_step: integerSchema,
    pending_since_ts: z.union([finiteNumberSchema, z.null()]),
    bid_release_step: integerSchema,
    end_reason_content: z.union([z.string(), z.null()]),
    transcript: z.array(transcriptEntrySchema),
    bid_threshold: finiteNumberSchema,
    min_bid_delay_ms: finiteNumberSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const agentNames = new Set(Object.keys(value.agents));

    for (const name of Object.keys(value.current_bids)) {
      if (!agentNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'current_bids keys must match agents',
          path: ['current_bids', name],
        });
      }
    }

    for (const name of Object.keys(value.current_thoughts)) {
      if (!agentNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'current_thoughts keys must match agents',
          path: ['current_thoughts', name],
        });
      }
    }

    for (const name of value.pending_bidders) {
      if (!agentNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pending_bidders entries must match agents',
          path: ['pending_bidders'],
        });
      }
    }

    if (value.current_speaker !== null && !agentNames.has(value.current_speaker)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'current_speaker must match agents',
        path: ['current_speaker'],
      });
    }

    if (value.status === 'speaking' && (value.current_speaker === null || value.speaker_type === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'speaking state requires current_speaker and speaker_type',
        path: ['status'],
      });
    }
  });

export const persistedDiscussSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    sessionId: z.string(),
    projectRoot: z.string(),
    updatedAt: z.string(),
    lastAppliedSeq: nonNegativeIntegerSchema,
    logByteOffset: nonNegativeIntegerSchema.optional(),
    state: persistedDiscussStateSchema,
    runtime: persistedDiscussRuntimeSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.state.session_id !== value.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'snapshot sessionId must match state.session_id',
        path: ['state', 'session_id'],
      });
    }

    for (const name of Object.keys(value.runtime.agentRuns)) {
      if (!(name in value.state.agents)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'runtime.agentRuns keys must be compatible with state.agents',
          path: ['runtime', 'agentRuns', name],
        });
      }
    }
  });

export const discussDiscoverySessionSchema = z
  .object({
    sessionId: z.string(),
    topic: z.string(),
    sessionDir: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export const discussSummaryIndexRowSchema = z
  .object({
    sessionId: z.string(),
    projectRoot: z.string(),
    topic: z.string(),
    status: discussStatusSchema,
    createdAt: z.string(),
    agentCount: nonNegativeIntegerSchema,
    updatedAt: z.string(),
    lastSeq: nonNegativeIntegerSchema,
  })
  .passthrough();

export function isValidDiscussDomainEvent(value: unknown): value is DiscussDomainEvent {
  return discussDomainEventSchema.safeParse(value).success;
}

export function isValidPersistedDiscussSnapshot(value: unknown): value is PersistedDiscussSnapshot {
  return persistedDiscussSnapshotSchema.safeParse(value).success;
}

type DiscussSourcesRegistryData = {
  updatedAt?: string;
  sources: string[];
};

export function parseSourceEnvelopeData<T>(
  value: unknown,
  source: string,
  rowSchema: z.ZodType<T>,
  label: string,
): { source: string; updatedAt: string; sessions: T[] } | null {
  const schema = z
    .object({
      updatedAt: z.string(),
      sessions: z.array(rowSchema),
      source: z.unknown().optional(),
      projectRoot: z.unknown().optional(),
    })
    .passthrough()
    .superRefine((envelope, ctx) => {
      let fileSource: string | null = null;
      if (typeof envelope.source === 'string') {
        fileSource = envelope.source;
      } else if (typeof envelope.projectRoot === 'string') {
        fileSource = source;
      }

      if (fileSource === source) return;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} source does not match requested source`,
        path: ['source'],
      });
    })
    .transform((envelope) => ({
      source,
      updatedAt: envelope.updatedAt,
      sessions: envelope.sessions,
    }));
  return parseWithSchema(schema, value);
}

export function parseDiscussDiscoveryData(value: unknown, source: string): DiscussDiscoveryData | null {
  return parseSourceEnvelopeData(value, source, discussDiscoverySessionSchema, 'discovery');
}

export function parseDiscussSummaryIndexData(value: unknown, source: string): DiscussSummaryIndexData | null {
  return parseSourceEnvelopeData(value, source, discussSummaryIndexRowSchema, 'summary index');
}

export function parseDiscussSourcesRegistry(
  value: unknown,
  projectSource: (projectRoot: string) => string,
): { updatedAt?: string; sources: string[] } | null {
  const schema = z
    .object({
      updatedAt: z.unknown().optional(),
      sources: z.unknown().optional(),
      projectRoots: z.unknown().optional(),
    })
    .passthrough()
    .superRefine((registry, ctx) => {
      if (registry.updatedAt !== undefined && typeof registry.updatedAt !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'updatedAt must be a string when present',
          path: ['updatedAt'],
        });
      }

      if (parseStringArray(registry.sources) !== null) {
        return;
      }

      if (parseStringArray(registry.projectRoots) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'registry must provide sources or projectRoots',
          path: ['sources'],
        });
      }
    })
    .transform((registry): DiscussSourcesRegistryData => {
      const updatedAt = typeof registry.updatedAt === 'string' ? registry.updatedAt : undefined;
      const sources = parseStringArray(registry.sources);
      if (sources !== null) {
        return {
          updatedAt,
          sources: [...new Set(sources)],
        };
      }

      const projectRoots = parseStringArray(registry.projectRoots) ?? [];
      return {
        updatedAt,
        sources: [...new Set(projectRoots.map((projectRoot) => projectSource(projectRoot)))],
      };
  });
  return parseWithSchema(schema, value);
}
