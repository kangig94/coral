import { z } from 'zod';

import { nonEmptyStringSchema } from '../infra/identifiers.js';
import type { StoragePort } from '../infra/port-types.js';
import type { ExecResult, IdPort, Runtime } from '../runtime/ports.js';
import type { JsonValue } from '../infra/json-value.js';
import type { ProviderExecutionPlan } from './execution-plan.js';
import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import {
  SESSION_ADAPTER_UNPARSEABLE_EVENT,
  SESSION_PROVIDER_FAILED_EVENT,
  type ProviderFailureCause,
} from './fault.js';
import type { SessionContinuityMutation } from '../sessions/continuity-mutation.js';
import type { AbortReason } from '../jobs/outcome.js';
import { providerArtifactIdentitySchema, type ProviderArtifactIdentity } from './artifact-identity.js';
import { sessionProviderFailureDiagnosticSchema } from '../sessions/fault.js';
import type {
  AppServerNotificationMessage,
  ProviderCliRequest,
  ProviderCliRunner,
  ProviderTransportClose,
} from './protocol.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ProviderAction = 'exec' | 'resume';
/** Provider-private account authority represented as canonical snapshot-safe data. */
export type ProviderSource = JsonValue;

export const providerInstructionSchema = z
  .object({
    content: z.string(),
    channel: z.enum(['prompt', 'system']),
  })
  .strict();
export type ProviderInstruction = z.infer<typeof providerInstructionSchema>;

export interface UsageSummary {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Workflow-aggregate only — set solely by aggregateWorkflowUsage at read time; providers MUST never emit it. */
  jobsWithoutCostData?: number;
}

export const USAGE_TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;

// Totals are derived by renderers from the four additive token buckets when all
// are present; totalTokens is intentionally never stored on the contract.
export const usageSummarySchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().optional(),
    /** Workflow-aggregate only — set solely by aggregateWorkflowUsage at read time; providers MUST never emit it. */
    jobsWithoutCostData: z.number().int().nonnegative().optional(),
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

interface ProviderServerSpecBase {
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  initializeRequest?: {
    method: string;
    params: Record<string, unknown>;
  };
  initializeTimeoutMs?: number;
  shutdownCapability?: {
    method: string;
    timeoutMs: number;
  };
}

export type ProviderServerSpec = ProviderServerSpecBase &
  (
    | {
        leaseMode: 'shared';
        /** Evidence required before the manager may retire an unpinned shared host. */
        idlePolicy: 'host-stats' | 'daemon';
      }
    | {
        leaseMode: 'job-exclusive';
        idlePolicy?: never;
      }
  );

/** Persistable, non-secret reference to one concrete managed app-server host. */
export type HostRef =
  | Readonly<{
      provider: string;
      fingerprint: string;
      instanceId: string;
      leaseMode: 'shared';
    }>
  | Readonly<{
      provider: string;
      fingerprint: string;
      instanceId: string;
      leaseMode: 'job-exclusive';
      ownerJobId: string;
    }>;

/** Provider-facing session. Process ownership and release remain capability-private. */
export interface AppServerTransport {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (msg: { method: string; params?: Record<string, unknown> }) => void): () => void;
  readonly closed: Promise<Error | void>;
}

export interface AppServerSession extends AppServerTransport {
  interrupt(continuity: ProviderContinuityBlob): Promise<boolean>;
}

export type ProviderCurationRequest = {
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
  readonly permissionMode?: 'default' | 'auto' | 'bypassPermissions';
  readonly signal?: AbortSignal;
};

export type ProviderCurationPreparationRuntime = {
  readonly storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'>;
  readonly ids: Pick<IdPort, 'uuid' | 'sha256'>;
  readonly baseEnv: Readonly<Record<string, string>>;
  readonly platform: string;
};

export type ProviderPreparedCuration = Readonly<{
  complete(runtime: { readonly appServerSession: AppServerSession }): Promise<string>;
}>;

export type ProviderCurationUsageRuntime = {
  readonly storage: Pick<StoragePort, 'readFileSync'>;
  readonly now: () => number;
};

/** Provider-owned daemon-internal assistant work exposed only through a bound provider. */
export interface ProviderCurationCapability<Source extends ProviderSource> {
  prepare(
    request: ProviderCurationRequest,
    runtime: ProviderCurationPreparationRuntime & { readonly source: Source },
  ): ProviderPreparedCuration;
  isUsageBudgetExhausted(runtime: ProviderCurationUsageRuntime & { readonly source: Source }): boolean;
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
  durationMs: number;
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
  identity: ProviderArtifactIdentity;
};

export type ProviderSuspendedEventBody = {
  kind: 'suspended';
  reason: 'interrupt_unconfirmed';
};

export type ProviderEventBody =
  | ProviderProgressEventBody
  | ProviderContinuityEventBody
  | ProviderArtifactHandleEventBody
  | ProviderSuspendedEventBody
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
          diagnostic: sessionProviderFailureDiagnosticSchema.optional(),
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
    durationMs: z.number().nonnegative(),
    exitCode: z.number().nullable().optional(),
    usage: usageSummarySchema.optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

// Provider-side terminal diagnostics: byteCounts + warnings only. The
// post-projection shape lives in `jobs/terminal/result.ts` (progress faults
// get attached during projection); naming the two schemas distinctly avoids
// the magnet hazard of two schemas sharing one identifier.
const providerTerminalDiagnosticsSchema = z
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
    identity: providerArtifactIdentitySchema,
  })
  .strict();

export const providerSuspendedEventBodySchema = z
  .object({
    kind: z.literal('suspended'),
    reason: z.literal('interrupt_unconfirmed'),
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
  })
  .describe('couple-provider-terminal-failure-cause');

export type ProviderContinuityUpdate = {
  conversationRef?: string | null;
  resumable?: boolean;
  providerContinuity?: ProviderContinuityBlob;
  [key: string]: unknown;
};

interface ProviderContinuityBridge {
  checkpoint(update: ProviderContinuityUpdate): Promise<void> | void;
  transportClosed(closed: ProviderTransportClose): void;
}

export interface ProviderEquippedToolSummary {
  readonly id: string;
  readonly summary: string;
  readonly guidance?: readonly string[];
}

interface ProviderRuntimeCommon<Plan extends ProviderExecutionPlan> {
  signal: AbortSignal;
  time: Pick<Runtime['time'], 'now' | 'setTimeout' | 'clearTimeout'>;
  storage: Pick<Runtime['storage'], 'readFileSync' | 'statSync' | 'existsSync' | 'readdirSync'>;
  env?: Pick<Runtime['env'], 'homedir' | 'fullSnapshot' | 'get'>;
  ids: Pick<IdPort, 'uuid' | 'sha256'>;
  persistedContinuity?: ProviderContinuityBlob;
  continuityBridge: ProviderContinuityBridge;
  /**
   * Resolved KB markdown root from `runtime.paths.coral.corpus.kbRoot`.
   * Providers use this when rendering inject fragment placeholders without
   * computing KB paths themselves (which would create a `providers → kb`
   * domain leak and bypass the runtime-path ownership model).
   */
  kbRoot: string;
  /** Resolved per-project data dir for the request cwd (`runtime.paths.projectData`); absent when no cwd. */
  coralProjects?: string;
  /** Resolved project source for the request cwd (`runtime.paths.projectSource`); absent when no cwd. */
  projectSource?: string;
  /** Installed /equip tools that should be advertised in provider system prompts. */
  equippedTools?: readonly ProviderEquippedToolSummary[];
  /** Provider-private lifetime-scoped plan. Generic execution code never inspects its payloads. */
  executionPlan: Plan;
}

export type ProviderAppServerRuntime<Plan extends ProviderExecutionPlan = ProviderExecutionPlan> =
  ProviderRuntimeCommon<Plan> & {
    readonly transport: 'app-server';
    readonly appServerSession: AppServerSession;
  };

export type ProviderStandaloneRuntime<Plan extends ProviderExecutionPlan = ProviderExecutionPlan> =
  ProviderRuntimeCommon<Plan> & {
    readonly transport: 'standalone';
    readonly runCli: ProviderCliRunner;
  };

export type ProviderRuntime<Plan extends ProviderExecutionPlan = ProviderExecutionPlan> =
  | ProviderAppServerRuntime<Plan>
  | ProviderStandaloneRuntime<Plan>;

export type Provider<
  Plan extends ProviderExecutionPlan = ProviderExecutionPlan,
  ExecutionRuntime extends ProviderRuntime<Plan> = ProviderRuntime<Plan>,
> = (request: ProviderRequest, runtime: ExecutionRuntime) => AsyncIterable<ProviderEventBody>;
export type ProviderAppServer<Plan extends ProviderExecutionPlan = ProviderExecutionPlan> = Provider<
  Plan,
  ProviderAppServerRuntime<Plan>
>;
export type ProviderStandalone<Plan extends ProviderExecutionPlan = ProviderExecutionPlan> = Provider<
  Plan,
  ProviderStandaloneRuntime<Plan>
>;
export type ProviderMiddleware<
  Plan extends ProviderExecutionPlan = ProviderExecutionPlan,
  ExecutionRuntime extends ProviderRuntime<Plan> = ProviderRuntime<Plan>,
> = (next: Provider<Plan, ExecutionRuntime>) => Provider<Plan, ExecutionRuntime>;

type ProviderHostPlanningContext<Source extends ProviderSource> = Readonly<{
  source: Source;
  baseEnv: Readonly<Record<string, string>>;
  platform: string;
  storage: Pick<StoragePort, 'existsSync'>;
}>;

export type ProviderHostPlanningInput<Source extends ProviderSource = ProviderSource> =
  | (ProviderHostPlanningContext<Source> &
      Readonly<{
        purpose: 'execution';
        request: ProviderRequest;
        persistedContinuity?: ProviderContinuityBlob;
      }>)
  | (ProviderHostPlanningContext<Source> &
      Readonly<{
        purpose: 'curation';
        request: ProviderCurationRequest;
      }>);

export interface ProviderAppServerCapability<
  Plan extends ProviderExecutionPlan = ProviderExecutionPlan,
  Source extends ProviderSource = ProviderSource,
> {
  readonly name: string;
  planHost(input: ProviderHostPlanningInput<Source>): Plan['host'];
  compileStableHost(host: Plan['host']): ProviderServerSpec;
  interrupt?(session: AppServerTransport, continuity: ProviderContinuityBlob): Promise<boolean>;
  probe?(
    session: AppServerTransport,
    continuity: ProviderContinuityBlob,
    context: Readonly<{ request: Pick<ProviderRequest, 'cwd'> }>,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  onNotification?(message: AppServerNotificationMessage): void;
}

export interface ProviderRecoveryContract<Source extends ProviderSource = ProviderSource> {
  /**
   * Provider-owned interpretation of an interrupted app-server turn.
   *
   * The coordinator supplies observations only. It must never invent provider
   * continuity semantics when the provider cannot be probed or no continuity
   * blob has been checkpointed yet.
   */
  finalizeInterrupted(
    probeResult: { resumable: boolean; updatedContinuity?: ProviderContinuityBlob },
    continuity: ProviderContinuityBlob | undefined,
    context: { preservedConversationRef?: string },
  ): SessionContinuityMutation;
  finalizeFromArtifacts(options: {
    source: Source;
    stdoutPath: string;
    stderrPath: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
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
  extractProgress?(options: { stdoutPath: string; fromOffset: number }): {
    messages: string[];
    newOffset: number;
  };
}

export type PreflightRuntime = Pick<Runtime, 'process' | 'storage' | 'env' | 'time'>;
export type ProviderPreflightRuntime<Source extends ProviderSource = ProviderSource> = PreflightRuntime & {
  credentialSource: Source;
  cwd: string;
  runExact(command: string, args: string[], options?: { timeout?: number; encoding?: 'utf-8' }): Promise<ExecResult>;
};
export type ProviderPreflightInput<Source extends ProviderSource = ProviderSource> = PreflightRuntime & {
  credentialSource: Source;
  cwd: string;
  baseEnv: Readonly<Record<string, string>>;
  requestEnv: Readonly<Record<string, string>>;
  platform: string;
};
export type ArtifactCleanupRuntime = Pick<Runtime, 'storage' | 'env' | 'paths' | 'time'>;

export type ProviderArtifactHandle = string;

export type ProviderArtifactHandleInput = {
  readonly handle: ProviderArtifactHandle;
  readonly identity: ProviderArtifactIdentity;
  readonly sourceJobId?: string;
};

export type DiscardOutcome =
  | { readonly kind: 'discarded'; readonly details?: Record<string, unknown> }
  | { readonly kind: 'skipped_no_handles'; readonly details?: Record<string, unknown> }
  | { readonly kind: 'provider_declares_none'; readonly details?: Record<string, unknown> };

export interface ProviderManagedArtifactCapability<Source extends ProviderSource = ProviderSource> {
  readonly kind: 'managed';
  discardArtifacts(options: {
    handles: readonly ProviderArtifactHandle[];
    source: Source;
    runtime: ArtifactCleanupRuntime;
  }): Promise<DiscardOutcome>;
  /**
   * Best-effort terminal-time fallback. In-run handle emission can miss the
   * native artifact when the provider has not yet flushed it to disk. At
   * discard time — well after the turn, when the file is durably written — the
   * retention reactor re-locates it from the session's persisted
   * conversationRef so cleanup does not silently skip.
   */
  locateArtifact?(options: {
    conversationRef: string;
    source: Source;
    runtime: ArtifactCleanupRuntime;
  }): ProviderArtifactHandle | null;
}

export interface ProviderNoArtifactCapability {
  readonly kind: 'none';
  readonly reason: string;
}

export type ProviderArtifactCapability<Source extends ProviderSource = ProviderSource> =
  | ProviderManagedArtifactCapability<Source>
  | ProviderNoArtifactCapability;

type ProviderExecutionPreparationContext<Source extends ProviderSource> = {
  source: Source;
  request: ProviderRequest;
  persistedContinuity?: ProviderContinuityBlob;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
  storage: Pick<StoragePort, 'existsSync'>;
};

type ProviderAppServerPlanPreparation<Plan extends ProviderExecutionPlan, Source extends ProviderSource> = (
  input: ProviderExecutionPreparationContext<Source> & { hostPlan: Plan['host'] },
) => {
  readonly session: Plan['session'];
  readonly turn: Plan['turn'];
};

type ProviderStandalonePlanPreparation<Plan extends ProviderExecutionPlan, Source extends ProviderSource> = (
  input: ProviderExecutionPreparationContext<Source>,
) => {
  readonly plan: Plan;
  prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
};

type ProviderImplementationCommon<Source extends ProviderSource> = {
  readonly name: string;
  readonly preflight?: (input: ProviderPreflightInput<Source>) => Promise<void>;
  readonly recovery?: ProviderRecoveryContract<Source>;
};

export type ProviderAppServerImplementation<
  Plan extends ProviderExecutionPlan,
  Source extends ProviderSource = ProviderSource,
> = ProviderImplementationCommon<Source> & {
  readonly transport: 'app-server';
  readonly run: ProviderAppServer<Plan>;
  readonly appServer: ProviderAppServerCapability<Plan, Source>;
  readonly prepareExecutionPlan: ProviderAppServerPlanPreparation<Plan, Source>;
  readonly curation?: ProviderCurationCapability<Source>;
};

export type ProviderStandaloneImplementation<
  Plan extends ProviderExecutionPlan,
  Source extends ProviderSource = ProviderSource,
> = ProviderImplementationCommon<Source> & {
  readonly transport: 'standalone';
  readonly run: ProviderStandalone<Plan>;
  readonly prepareExecutionPlan: ProviderStandalonePlanPreparation<Plan, Source>;
};

export type ProviderImplementation<
  Plan extends ProviderExecutionPlan,
  Source extends ProviderSource = ProviderSource,
> = ProviderAppServerImplementation<Plan, Source> | ProviderStandaloneImplementation<Plan, Source>;

export function compose<Plan extends ProviderExecutionPlan, ExecutionRuntime extends ProviderRuntime<Plan>>(
  middleware: readonly ProviderMiddleware<Plan, ExecutionRuntime>[],
  provider: Provider<Plan, ExecutionRuntime>,
): Provider<Plan, ExecutionRuntime>;
export function compose<Plan extends ProviderExecutionPlan, ExecutionRuntime extends ProviderRuntime<Plan>>(
  ...parts: readonly [...ProviderMiddleware<Plan, ExecutionRuntime>[], Provider<Plan, ExecutionRuntime>]
): Provider<Plan, ExecutionRuntime>;
export function compose<Plan extends ProviderExecutionPlan, ExecutionRuntime extends ProviderRuntime<Plan>>(
  ...parts:
    | readonly [readonly ProviderMiddleware<Plan, ExecutionRuntime>[], Provider<Plan, ExecutionRuntime>]
    | readonly [...ProviderMiddleware<Plan, ExecutionRuntime>[], Provider<Plan, ExecutionRuntime>]
): Provider<Plan, ExecutionRuntime> {
  const [middleware, provider] =
    parts.length === 2 && Array.isArray(parts[0])
      ? [parts[0], parts[1]]
      : [
          parts.slice(0, -1) as readonly ProviderMiddleware<Plan, ExecutionRuntime>[],
          parts[parts.length - 1] as Provider<Plan, ExecutionRuntime>,
        ];

  const composed = middleware.reduceRight((next, layer) => layer(next), provider);

  // The composition root owns the single final-disposition invariant for
  // every provider stream. A confirmed outcome is terminal; an interruption
  // whose exact provider turn remains live is suspended for durable recovery.
  return async function* finalDispositionProvider(request, runtime) {
    const startedAt = runtime.time.now();
    let seenFinal = false;
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
        yield event;
        if (event.kind === 'terminal' || event.kind === 'suspended') {
          seenFinal = true;
          return;
        }
      }
    } finally {
      if (!naturalCompletion && typeof iterator.return === 'function') {
        await iterator.return().catch(() => undefined);
      }
      // Synthesize wrapper_lost only when the inner iterator returned of its
      // own accord without a terminal or suspension. Consumer-driven .return()
      // and propagating exceptions are intentional close signals.
      if (naturalCompletion && !seenFinal) {
        yield {
          kind: 'terminal',
          terminal: {
            content: '',
            durationMs: Math.max(0, runtime.time.now() - startedAt),
            outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
          },
          diagnostics: {},
        };
      }
    }
  };
}
