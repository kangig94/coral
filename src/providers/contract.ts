import { z } from 'zod';

import { nonEmptyStringSchema } from '../infra/identifiers.js';
import type { StoragePort } from '../infra/port-types.js';
import type { IdPort, Runtime } from '../runtime/ports.js';
import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import {
  SESSION_ADAPTER_UNPARSEABLE_EVENT,
  SESSION_PROVIDER_FAILED_EVENT,
  type ProviderFailureCause,
} from './fault.js';
import type { SessionContinuityMutation } from '../sessions/continuity-mutation.js';
import type { AbortReason } from '../jobs/outcome.js';
import { providerArtifactIdentitySchema, type ProviderArtifactIdentity } from './artifact-identity.js';
import type {
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
  ProviderCliRunner,
  ProviderTransportClose,
} from './protocol.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ProviderAction = 'exec' | 'resume';

export const providerInstructionSchema = z
  .object({
    content: z.string(),
    channel: z.enum(['prompt', 'system']),
  })
  .strict();
export type ProviderInstruction = z.infer<typeof providerInstructionSchema>;

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

// Provider-side terminal outcome: the slice of `TerminalOutcome` that the
// provider kernel can directly emit before the materializer enriches it
// with causeRef and the full fault registry. The schema below is the
// canonical shape; this type is its compile-time mirror via z.infer.
export type ProviderTerminalOutcome = z.infer<typeof providerTerminalOutcomeSchema>;

/** Provider's raw terminal output shape — what an exec/app-server kernel returns
 * before the coordinator materializer translates it into a journal-recorded
 * `ProviderTerminal` (in `jobs/terminal/result.ts`). Distinct types, distinct names
 * per §10.3. */
export interface ProviderTerminal {
  content: string;
  model?: string;
  outcome: ProviderTerminalOutcome;
  durationMs?: number;
  /** @wire node:child_process — provider exit code; mirrors child_process exit semantics. */
  exitCode?: number | null;
  usage?: UsageSummary;
  warnings?: string[];
}

/** Provider-side diagnostics captured at exec time (output byte counts,
 * warnings). Translated into `JobTerminalDiagnostics` (jobs/terminal/result.ts)
 * by the coordinator materializer; `byteCounts` flows through to the journal
 * so wait/detail surfaces can show output size. */
export interface ProviderJobDiagnostics {
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
  providerContinuity: ProviderContinuityBlob | null;
};

export type ProviderTerminalEventBody = {
  kind: 'terminal';
  terminal: ProviderTerminal;
  diagnostics: ProviderJobDiagnostics;
  failureCause?: ProviderFailureCause;
};

export type ProviderArtifactHandleEventBody = {
  kind: 'artifact_handle';
  handle: string;
  identity?: ProviderArtifactIdentity;
};

export type ProviderEventBody =
  | ProviderProgressEventBody
  | ProviderContinuityEventBody
  | ProviderArtifactHandleEventBody
  | ProviderTerminalEventBody;

const abortReasons = ['signal_abort', 'user_abort', 'queue_shutdown'] as const satisfies readonly AbortReason[];

export const providerFailureCauseSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal(SESSION_ADAPTER_UNPARSEABLE_EVENT),
      body: z
        .object({
          provider: z.string(),
          exitCode: z.number().nullable(),
          stdout: z.string(),
          stderr: z.string(),
          parseError: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal(SESSION_PROVIDER_FAILED_EVENT),
      body: z
        .object({
          provider: z.string(),
          reason: z.enum(['session_unavailable', 'request_failed']),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

// Provider-side terminal-outcome subset: `failed` carries no causeRef
// and `job_fault` is restricted to `wrapper_lost`. The post-projection
// shape lives in `jobs/outcome.ts` and folds in causeRef + the full
// fault registry. Distinct names per the magnet-hazard convention
// documented just below.
export const providerTerminalOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('aborted'), reason: z.enum(abortReasons) }).strict(),
  z.object({ kind: z.literal('provider_exit'), code: z.number(), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal('failed') }).strict(),
  z
    .object({
      kind: z.literal('job_fault'),
      fault: z.object({ kind: z.literal('wrapper_lost') }).strict(),
    })
    .strict(),
]);

// Provider-side job terminal record. The post-projection equivalent
// lives in `jobs/terminal/result.ts:jobTerminalSchema`; same magnet-
// hazard naming convention as `providerTerminalDiagnosticsSchema`.
export const providerJobTerminalSchema = z
  .object({
    content: z.string(),
    model: z.string().optional(),
    outcome: providerTerminalOutcomeSchema,
    durationMs: z.number().optional(),
    exitCode: z.number().nullable().optional(),
    usage: usageSummarySchema.optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

// Provider-side terminal diagnostics: byteCounts + warnings only. The
// post-projection shape lives in `jobs/terminal/result.ts` (progress faults
// get attached during projection); naming the two schemas distinctly avoids
// the magnet hazard of two schemas sharing one identifier.
export const providerTerminalDiagnosticsSchema = z
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

export const providerContinuityEventBodySchema = z
  .object({
    kind: z.literal('continuity'),
    conversationRef: nonEmptyStringSchema.nullable(),
    resumable: z.boolean(),
    providerContinuity: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export const providerArtifactHandleEventBodySchema = z
  .object({
    kind: z.literal('artifact_handle'),
    handle: z.string().min(1),
    identity: providerArtifactIdentitySchema.optional(),
  })
  .strict();

export const providerTerminalEventBodySchema = z
  .object({
    kind: z.literal('terminal'),
    terminal: providerJobTerminalSchema,
    diagnostics: providerTerminalDiagnosticsSchema,
    failureCause: providerFailureCauseSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.terminal.outcome.kind === 'failed' && event.failureCause === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCause'],
        message: 'failed provider terminals must carry a canonical failureCause',
      });
    }
    if (event.terminal.outcome.kind !== 'failed' && event.failureCause !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCause'],
        message: 'non-failed provider terminals must not carry failureCause',
      });
    }
  });

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
  time: Pick<Runtime['time'], 'now' | 'setTimeout' | 'clearTimeout'>;
  storage: Pick<Runtime['storage'], 'readFileSync' | 'statSync' | 'existsSync' | 'readdirSync'>;
  env?: Pick<Runtime['env'], 'homedir' | 'fullSnapshot' | 'get'>;
  ids: Pick<IdPort, 'uuid' | 'sha256'>;
  acquireServer: (spec: ProviderServerSpec) => Promise<ProviderServerLease>;
  persistedContinuity?: ProviderContinuityBlob;
  continuityBridge: ProviderContinuityBridge;
  /**
   * Resolved KB markdown root from `runtime.paths.coral.corpus.kbRoot`.
   * Providers use this when rendering `INJECT.md` placeholders without
   * computing KB paths themselves (which would create a `providers → kb`
   * domain leak and bypass the runtime-path ownership model).
   */
  kbRoot: string;
  /** Resolved per-project data dir for the request cwd (`runtime.paths.projectData`); absent when no cwd. */
  coralProjects?: string;
  /** Resolved project source for the request cwd (`runtime.paths.projectSource`); absent when no cwd. */
  projectSource?: string;
}

export type Provider = (request: ProviderRequest, runtime: ProviderRuntime) => AsyncIterable<ProviderEventBody>;
export type ProviderMiddleware = (next: Provider) => Provider;

export interface ProviderAppServerContract {
  readonly name: string;
  readonly subscriptionPhase: AppServerSubscriptionPhase;
  buildServerSpec(
    request: ProviderRequest,
    persistedContinuity: ProviderContinuityBlob | undefined,
    ports: { storage: Pick<StoragePort, 'existsSync'> },
  ): ProviderServerSpec;
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
    env: Pick<Runtime['env'], 'homedir' | 'get' | 'fullSnapshot'>;
    fallbackConversationRef?: string;
    knownArtifactHandles?: readonly ProviderArtifactHandleInput[];
    storage: Pick<StoragePort, 'readFileSync' | 'existsSync' | 'readdirSync' | 'statSync'>;
  }): Promise<{
    terminal: ProviderTerminalEventBody;
    artifactHandles?: readonly ProviderArtifactHandleInput[];
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

export type PreflightRuntime = Pick<Runtime, 'process' | 'storage' | 'env' | 'time'>;
export type ArtifactCleanupRuntime = Pick<Runtime, 'storage' | 'env'>;

export type ProviderArtifactHandle = string;

export type ProviderArtifactHandleInput = {
  readonly handle: ProviderArtifactHandle;
  readonly identity?: ProviderArtifactIdentity;
  readonly sourceJobId?: string;
};

export type DiscardOutcome =
  | { readonly kind: 'discarded'; readonly details?: Record<string, unknown> }
  | { readonly kind: 'skipped_no_handles'; readonly details?: Record<string, unknown> }
  | { readonly kind: 'provider_declares_none'; readonly details?: Record<string, unknown> };

export interface ProviderManagedArtifactCapability {
  readonly kind: 'managed';
  discardArtifacts(
    handles: readonly ProviderArtifactHandle[],
    runtime: ArtifactCleanupRuntime,
  ): Promise<DiscardOutcome>;
}

export interface ProviderNoArtifactCapability {
  readonly kind: 'none';
  readonly reason: string;
}

export type ProviderArtifactCapability = ProviderManagedArtifactCapability | ProviderNoArtifactCapability;

export interface ProviderSpec {
  readonly name: string;
  readonly run: Provider;
  readonly preflight?: (runtime: PreflightRuntime) => Promise<void>;
  readonly appServer?: ProviderAppServerContract;
  readonly recovery?: ProviderRecoveryContract;
}

export function compose(middleware: readonly ProviderMiddleware[], provider: Provider): Provider;
export function compose(...parts: readonly [...ProviderMiddleware[], Provider]): Provider;
export function compose(
  ...parts: readonly [readonly ProviderMiddleware[], Provider] | readonly [...ProviderMiddleware[], Provider]
): Provider {
  const [middleware, provider] =
    parts.length === 2 && Array.isArray(parts[0])
      ? [parts[0], parts[1]]
      : [parts.slice(0, -1) as readonly ProviderMiddleware[], parts[parts.length - 1] as Provider];

  const composed = middleware.reduceRight((next, layer) => layer(next), provider);

  // §8.3 #1: compose() owns the terminalOnce invariant for every provider
  // stream. Per-middleware defensive checks are not the right home; the
  // composition root sees the full chain end-to-end.
  return async function* terminalOnceProvider(request, runtime) {
    let seenTerminal = false;
    let naturalCompletion = false;
    const inner = composed(request, runtime);
    const iterator = inner[Symbol.asyncIterator]();

    try {
      while (true) {
        const result = await iterator.next();
        if (result.done) {
          naturalCompletion = true;
          break;
        }
        const event = result.value;
        if (seenTerminal) {
          // Stream already terminated; drop further yields. A well-behaved
          // kernel should not emit after terminal, but if it does, dropping
          // here keeps downstream projections from seeing two terminals.
          continue;
        }
        yield event;
        if (event.kind === 'terminal') {
          seenTerminal = true;
        }
      }
    } finally {
      // Synthesize wrapper_lost only when the inner iterator returned of its
      // own accord without ever yielding a terminal. Consumer-driven .return()
      // and propagating exceptions are intentional close signals — let them
      // pass through unchanged. §7.2: wrapper_lost is the JobLifecycleFault
      // for "kernel closed without reporting an outcome."
      if (naturalCompletion && !seenTerminal) {
        yield {
          kind: 'terminal',
          terminal: {
            content: '',
            outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
          },
          diagnostics: {},
        };
      }
    }
  };
}
