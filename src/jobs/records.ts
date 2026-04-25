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
import type { SourceImportReadiness } from './launch.js';

export function belongsToNamespace(status: JobStatus, namespace: string): boolean {
  return (
    typeof status.backendNamespace === 'string' &&
    status.backendNamespace.length > 0 &&
    status.backendNamespace === namespace
  );
}

export type JobKind = 'provider' | 'workflow' | 'kb';

export interface JobExit extends JobTerminal {
  diagnostics: JobDiagnostics;
  exitCode?: number | null;
  continuity?: JobContinuitySnapshot | null;
  signal?: string | null;
  endTime: string;
}

export interface JobStatus {
  jobId: string;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: JobKind;
  phase: JobPhase;
  updatedAt: string;
  lastSeq?: number;
  result?: JobTerminal;
  continuity?: JobContinuitySnapshot | null;
}

export const jobStatusSchema = z
  .object({
    jobId: z.string(),
    sessionId: z.string().nullable(),
    provider: z.string().nullable(),
    projectRoot: z.string(),
    backendNamespace: z.string(),
    bundleHash: z.string().optional(),
    jobKind: z.enum(['provider', 'workflow', 'kb']),
    phase: jobPhaseSchema,
    updatedAt: z.string(),
    lastSeq: z.number().int().nonnegative().optional(),
    result: jobTerminalSchema.optional(),
    diagnostics: jobDiagnosticsSchema.optional(),
    continuity: jobContinuitySnapshotSchema.nullable().optional(),
  })
  .strict();

export function parseJobStatus(value: unknown): JobStatus | null {
  const parsed = jobStatusSchema.safeParse(value);
  return parsed.success ? (parsed.data as JobStatus) : null;
}

export function safeParseJobStatus(value: unknown) {
  return jobStatusSchema.safeParse(value);
}

export interface JobLaunch {
  jobId: string;
  sessionId: string | null;
  provider: string | null;
  projectRoot: string;
  backendNamespace: string;
  bundleHash?: string;
  jobKind: JobKind;
  pool: string;
  enqueueSequence: number;
  providerAction?: ProviderAction;
  operation?: 'kb.source_import' | 'kb.reindex';
  request: {
    prompt?: string;
    name?: string;
    model?: string;
    cwd?: string;
    effort?: string;
    bypassPermissions?: boolean;
    systemPrompt?: string;
    conversationRef?: string;
    instruction?: ProviderInstruction;
    coralEnv?: Record<string, string>;
    filePath?: string;
    slug?: string;
    readiness?: SourceImportReadiness;
  };
  parentWorkflowJobId?: string;
  workflowSlotId?: string;
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

export interface InternalJobRuntime {
  transport: 'internal';
  operation: 'kb.source_import' | 'kb.reindex';
  startTime: string;
}

export type JobRuntime = DurableCliRuntimeRecord | AppServerRuntime | InternalJobRuntime;

export function isAppServerRuntime(record: JobRuntime | null | undefined): record is AppServerRuntime {
  return record?.transport === 'app-server';
}

export function isInternalJobRuntime(record: JobRuntime | null | undefined): record is InternalJobRuntime {
  return record?.transport === 'internal';
}

export interface JobProgress {
  jobId: string;
  sessionId: string | null;
  seq: number;
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
} from './result.js';
export {
  cloneJobTerminal,
  jobDiagnosticsSchema,
  jobTerminalSchema,
  normalizeJobTerminal,
} from './result.js';
