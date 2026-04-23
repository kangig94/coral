import { z } from 'zod';

import { jobContinuitySnapshotSchema, type JobContinuitySnapshot } from './continuity.js';
import {
  jobDiagnosticsSchema,
  jobTerminalSchema,
  type JobDiagnostics,
  type JobTerminal,
} from './result.js';
import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import type { DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';
import { type ProviderAction, type ProviderInstruction } from '../providers/contract.js';
import { jobPhaseSchema, type JobPhase } from './phase.js';

export function belongsToNamespace(status: JobStatus, namespace: string): boolean {
  return (
    typeof status.backendNamespace === 'string' &&
    status.backendNamespace.length > 0 &&
    status.backendNamespace === namespace
  );
}

export type LaunchState = 'pending' | 'queued' | 'ready' | 'busy' | 'error';

export const launchStateSchema = z.enum(['pending', 'queued', 'ready', 'busy', 'error']);

export type JobKind = 'provider' | 'workflow';

export interface JobExit extends JobTerminal {
  diagnostics: JobDiagnostics;
  exitCode?: number | null;
  continuity?: JobContinuitySnapshot | null;
  signal?: string | null;
  endTime: string;
}

export interface JobStatus {
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
  result?: JobTerminal;
  continuity?: JobContinuitySnapshot | null;
}

export const jobStatusSchema = z
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
    result: jobTerminalSchema.optional(),
    diagnostics: jobDiagnosticsSchema.optional(),
    continuity: jobContinuitySnapshotSchema.nullable().optional(),
  })
  .passthrough();

export function parseJobStatus(value: unknown): JobStatus | null {
  const parsed = jobStatusSchema.safeParse(value);
  return parsed.success ? (parsed.data as JobStatus) : null;
}

export function safeParseJobStatus(value: unknown) {
  return jobStatusSchema.safeParse(value);
}

export interface JobLaunch {
  jobId: string;
  sessionId: string;
  provider: string;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: JobKind;
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

export interface AppServerRuntime {
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

export type JobRuntime = DurableCliRuntimeRecord | AppServerRuntime;

export function isAppServerRuntime(record: JobRuntime | null | undefined): record is AppServerRuntime {
  return record?.transport === 'app-server';
}

export interface JobProgress {
  jobId: string;
  sessionId: string;
  seq: number;
  eventId: number;
  type: 'progress' | 'terminal';
  ts: string;
  message?: string;
  result?: JobTerminal;
  continuity?: JobContinuitySnapshot | null;
}

export type {
  JobDiagnostics,
  JobTerminal,
  JobTerminalDiagnostics,
  JobTerminalInput,
  WorkflowResultMeta,
  WorkflowStepMeta,
} from './result.js';
export {
  cloneJobTerminal,
  jobDiagnosticsSchema,
  jobTerminalSchema,
  normalizeJobTerminal,
  workflowResultMetaSchema,
} from './result.js';
