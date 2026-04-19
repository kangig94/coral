import { z } from 'zod';

import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import type { DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';
import {
  type ProviderAction,
  type ProviderInstruction,
  type UsageSummary,
  usageSummarySchema,
} from '../providers/protocol.js';
import { type TerminalOutcome, terminalOutcomeSchema } from './outcome.js';
import { jobPhaseSchema, type JobPhase } from './phase.js';

export function readBackendNamespace(status: JobStatusRecord): string | null {
  return typeof status.backendNamespace === 'string' && status.backendNamespace.length > 0
    ? status.backendNamespace
    : null;
}

export function belongsToNamespace(status: JobStatusRecord, namespace: string): boolean {
  return readBackendNamespace(status) === namespace;
}

export type LaunchState = 'pending' | 'queued' | 'ready' | 'busy' | 'error';

export const launchStateSchema = z.enum(['pending', 'queued', 'ready', 'busy', 'error']);

export interface WorkflowStepMeta {
  agent: string;
  step: number;
  atom: number;
  provider: string;
  start: number;
  end: number;
}

export interface WorkflowResultMeta {
  steps: WorkflowStepMeta[];
}

const workflowStepMetaSchema = z
  .object({
    agent: z.string(),
    step: z.number(),
    atom: z.number(),
    provider: z.string(),
    start: z.number(),
    end: z.number(),
  })
  .strict();

export const workflowResultMetaSchema = z
  .object({
    steps: z.array(workflowStepMetaSchema),
  })
  .strict();

export type JobKind = 'provider' | 'workflow';

export interface JobTerminalRecord {
  content: string;
  durationMs?: number;
  nonResumable?: boolean;
  exitCode?: number | null;
  warnings?: string[];
  usage?: UsageSummary;
  workflow?: WorkflowResultMeta;
  outcome: TerminalOutcome;
}

export const terminalResultSchema = z
  .object({
    content: z.string(),
    durationMs: z.number().optional(),
    nonResumable: z.boolean().optional(),
    exitCode: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    workflow: workflowResultMetaSchema.optional(),
    outcome: terminalOutcomeSchema,
  })
  .strict();

export interface JobStatusRecord {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: JobKind;
  phase: JobPhase;
  launch: {
    state: LaunchState;
    message?: string;
    updatedAt: string;
  };
  result?: JobTerminalRecord;
}

export const jobStatusRecordSchema = z
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
        state: launchStateSchema,
        message: z.string().optional(),
        updatedAt: z.string(),
      })
      .passthrough(),
    result: terminalResultSchema.optional(),
  })
  .passthrough();

export function parseJobStatusRecord(value: unknown): JobStatusRecord | null {
  const parsed = jobStatusRecordSchema.safeParse(value);
  return parsed.success ? (parsed.data as JobStatusRecord) : null;
}

export function safeParseJobStatusRecord(value: unknown) {
  return jobStatusRecordSchema.safeParse(value);
}

export interface JobLaunchRecord {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind?: JobKind;
  pool: string;
  enqueueSequence: number;
  providerAction: ProviderAction;
  request: {
    prompt: string;
    name?: string;
    model?: string;
    cwd: string;
    effort?: string;
    bypassPermissions: boolean;
    systemPrompt?: string;
    conversationRef?: string;
    instruction?: ProviderInstruction;
    coralEnv: Record<string, string>;
  };
  parentWorkflowJobId?: string;
  createdAt: string;
}

export interface AppServerRuntimeRecord {
  transport: 'app-server';
  startTime: string;
  providerMeta: {
    provider: string;
    leaseState: 'waiting' | 'acquired';
    serverGeneration?: number;
    providerContinuity?: ProviderContinuityBlob;
    recoveryPolicy: 'session_continuity_only';
  };
}

export type JobRuntimeRecord = DurableCliRuntimeRecord | AppServerRuntimeRecord;

export function isAppServerRuntime(
  record: JobRuntimeRecord | null | undefined,
): record is AppServerRuntimeRecord {
  return record?.transport === 'app-server';
}

export interface JobProgressRecord {
  jobId: string;
  sessionId: string;
  eventId: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminalRecord;
}
