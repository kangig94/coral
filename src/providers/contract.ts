import { z } from 'zod';

import type { Runtime } from '../runtime/ports.js';
import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import {
  ADAPTER_OUTPUT_UNPARSEABLE_KIND,
  PROVIDER_REQUEST_FAILED_KIND,
  PROVIDER_SESSION_UNAVAILABLE_KIND,
  type FaultPayload,
} from './fault.js';
import type { SessionContinuityMutation } from './continuity-mutation.js';
import type {
  AbortReason,
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
  ProviderCliRunner,
  ProviderTransportClose,
} from './protocol.js';

export type { ProviderContinuityBlob } from '../sessions/continuity.js';
export type {
  AbortReason,
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
  ProviderCliRunner,
  ProviderTransportClose,
} from './protocol.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ProviderAction = 'exec' | 'resume' | 'fork';

export interface ProviderInstruction {
  content: string;
  channel: 'prompt' | 'system';
}

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export const usageSummarySchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  })
  .strict();

export interface ProviderRequest {
  action: ProviderAction;
  sessionId: string;
  name?: string;
  conversationRef?: string;
  prompt: string;
  model?: string;
  cwd: string;
  effort?: EffortLevel;
  bypassPermissions: boolean;
  systemPrompt?: string;
  coralEnv: Record<string, string>;
  instruction?: ProviderInstruction;
}

export interface ProviderRecoveryMeta {
  [key: string]: unknown;
}

export interface ProviderServerSpec {
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  shared?: boolean;
  initializeRequest?: {
    method: string;
    params: Record<string, unknown>;
  };
  shutdownCapability?: {
    method: string;
    timeoutMs: number;
  };
}

export interface ProviderServerLease {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (msg: { method: string; params?: Record<string, unknown> }) => void): () => void;
  release(): void;
  closed: Promise<Error | void>;
  generation?: number;
}

export type TerminalOutcome =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: 'signal_abort' | 'user_abort' | 'queue_shutdown' }
  | { kind: 'failed'; fault: FaultPayload };

export interface JobTerminal {
  content: string;
  model?: string;
  outcome: TerminalOutcome;
  durationMs?: number;
  exitCode?: number | null;
  usage?: UsageSummary;
  warnings?: string[];
}

export interface JobDiagnostics {
  byteCounts?: {
    stdout: number;
    stderr: number;
  };
  warnings?: string[];
}

export type ProviderProgressEventBody = {
  kind: 'progress';
  message: string;
};

export type ProviderContinuityEventBody = {
  kind: 'continuity';
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity?: ProviderContinuityBlob | null;
};

export type ProviderTerminalEventBody = {
  kind: 'terminal';
  terminal: JobTerminal;
  diagnostics: JobDiagnostics;
};

export type ProviderEventBody =
  | ProviderProgressEventBody
  | ProviderContinuityEventBody
  | ProviderTerminalEventBody;

const abortReasons = ['signal_abort', 'user_abort', 'queue_shutdown'] as const satisfies readonly AbortReason[];

export const faultPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal(ADAPTER_OUTPUT_UNPARSEABLE_KIND),
      provider: z.string(),
      exitCode: z.number().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      parseError: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(PROVIDER_SESSION_UNAVAILABLE_KIND),
      provider: z.string(),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(PROVIDER_REQUEST_FAILED_KIND),
      provider: z.string(),
      message: z.string(),
      cause: z.unknown().optional(),
    })
    .strict(),
]);

export const terminalOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('aborted'), reason: z.enum(abortReasons) }).strict(),
  z.object({ kind: z.literal('failed'), fault: faultPayloadSchema }).strict(),
]);

export const jobTerminalSchema = z
  .object({
    content: z.string(),
    model: z.string().optional(),
    outcome: terminalOutcomeSchema,
    durationMs: z.number().optional(),
    exitCode: z.number().nullable().optional(),
    usage: usageSummarySchema.optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export const jobDiagnosticsSchema = z
  .object({
    byteCounts: z
      .object({
        stdout: z.number(),
        stderr: z.number(),
      })
      .strict()
      .optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

export const providerProgressEventBodySchema = z
  .object({
    kind: z.literal('progress'),
    message: z.string(),
  })
  .strict();

export const providerContinuityEventBodySchema = z
  .object({
    kind: z.literal('continuity'),
    conversationRef: z.string().nullable(),
    resumable: z.boolean(),
    providerContinuity: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const providerTerminalEventBodySchema = z
  .object({
    kind: z.literal('terminal'),
    terminal: jobTerminalSchema,
    diagnostics: jobDiagnosticsSchema,
  })
  .strict();

export const providerEventBodySchema = z.discriminatedUnion('kind', [
  providerProgressEventBodySchema,
  providerContinuityEventBodySchema,
  providerTerminalEventBodySchema,
]);

export type ProviderContinuityUpdate = {
  conversationRef?: string | null;
  resumable?: boolean;
  providerContinuity?: ProviderContinuityBlob;
  [key: string]: unknown;
};

export interface ProviderContinuityBridge {
  checkpoint(update: ProviderContinuityUpdate): void;
  transportClosed(closed: ProviderTransportClose): void;
}

export interface ProviderRuntime {
  signal: AbortSignal;
  runCli: ProviderCliRunner;
  storage?: Pick<Runtime['storage'], 'readFileSync' | 'statSync'>;
  env?: Pick<Runtime['env'], 'homedir'>;
  acquireServer: (spec: ProviderServerSpec) => Promise<ProviderServerLease>;
  persistedContinuity?: ProviderContinuityBlob;
  continuityBridge: ProviderContinuityBridge;
}

export type Provider = (request: ProviderRequest, runtime: ProviderRuntime) => AsyncIterable<ProviderEventBody>;
export type ProviderMiddleware = (next: Provider) => Provider;

export interface ProviderAppServerContract {
  readonly name: string;
  readonly subscriptionPhase: AppServerSubscriptionPhase;
  buildServerSpec(request: ProviderRequest, persistedContinuity: ProviderContinuityBlob | undefined): ProviderServerSpec;
  interrupt(lease: ProviderServerLease, continuity: ProviderContinuityBlob): Promise<void>;
  onNotification?(message: AppServerNotificationMessage): void;
}

export interface ProviderRecoveryContract {
  probe?(
    lease: ProviderServerLease,
    continuity: ProviderContinuityBlob,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  finalizeInterrupted?(
    probeResult: { resumable: boolean; updatedContinuity?: ProviderContinuityBlob },
    continuity: ProviderContinuityBlob,
    context: { preservedConversationRef?: string },
  ): SessionContinuityMutation;
  finalizeFromArtifacts(options: {
    stdoutPath: string;
    stderrPath: string;
    exitCode: number | null;
    signal: string | null;
    providerMeta?: Record<string, unknown>;
    fallbackConversationRef?: string;
  }): Promise<{
    terminal: ProviderTerminalEventBody;
    continuity?: {
      conversationRef: string | null;
      resumable: boolean;
      providerContinuity?: ProviderContinuityBlob;
    };
  }>;
  buildRecoveryMeta?(request: ProviderRequest): ProviderRecoveryMeta;
  extractProgress?(options: { stdoutPath: string; fromOffset: number; providerMeta?: Record<string, unknown> }): {
    messages: string[];
    newOffset: number;
  };
}

export type PreflightRuntime = Pick<Runtime, 'process' | 'storage' | 'env'>;
export type ArtifactCleanupRuntime = Pick<Runtime, 'storage' | 'env'>;

export interface ProviderArtifactCleanup {
  readonly name: string;
  cleanupSessions(runtime: ArtifactCleanupRuntime, conversationRefs: readonly string[]): Promise<void>;
}

export interface ProviderSpec {
  readonly name: string;
  readonly run: Provider;
  readonly preflight?: (runtime: PreflightRuntime) => Promise<void>;
  readonly appServer?: ProviderAppServerContract;
  readonly recovery?: ProviderRecoveryContract;
  readonly cleanup?: ProviderArtifactCleanup;
}

export function compose(middleware: readonly ProviderMiddleware[], provider: Provider): Provider;
export function compose(...parts: readonly [...ProviderMiddleware[], Provider]): Provider;
export function compose(
  ...parts:
    | readonly [readonly ProviderMiddleware[], Provider]
    | readonly [...ProviderMiddleware[], Provider]
): Provider {
  const [middleware, provider] =
    parts.length === 2 && Array.isArray(parts[0])
      ? [parts[0], parts[1]]
      : [parts.slice(0, -1) as readonly ProviderMiddleware[], parts[parts.length - 1] as Provider];

  return middleware.reduceRight((next, layer) => layer(next), provider);
}
