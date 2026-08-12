import { z } from 'zod';

import { nonEmptyStringSchema } from '../infra/identifiers.js';
import type { StoragePort } from '../infra/port-types.js';
import type { ExecResult, IdPort, Runtime } from '../runtime/ports.js';
import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
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
export type ProviderAccess = JsonValue;

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
  cwd: CanonicalWorkDir;
  effort?: EffortLevel;
  bypassPermissions: boolean;
  systemPrompt?: string;
  coralEnv: Record<string, string>;
  instruction?: ProviderInstruction;
}

/**
 * `ProviderRequest` as wire bytes, for the one boundary that has to send it: a prepared operation crossing
 * into the proxy process (W2.3). It lives beside the interface it validates rather than in the transport that
 * carries it, so the request has one canonical home and a field added above cannot silently go unvalidated on
 * the wire — the two assertions below fail to compile if the schema and the interface drift.
 *
 * Strict, so a field this build does not know is refused at ingress rather than carried into an execution
 * that would ignore it.
 */
export const providerRequestSchema = z
  .object({
    action: z.enum(['exec', 'resume']),
    sessionId: nonEmptyStringSchema,
    name: z.string().optional(),
    conversationRef: nonEmptyStringSchema.optional(),
    prompt: z.string(),
    model: z.string().optional(),
    cwd: canonicalWorkDirWireSchema,
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
    bypassPermissions: z.boolean(),
    systemPrompt: z.string().optional(),
    coralEnv: z.record(z.string()),
    instruction: providerInstructionSchema.optional(),
  })
  .strict();

// Compile-time only. Mutual assignability alone is not enough: two object types still assign to each other
// when one simply omits an optional property, so dropping an optional field from the schema — the drift most
// likely to happen, since adding an optional field to the interface is the common edit — would pass silently.
// The key-set comparison is what closes that, and the assignability check is what catches a field whose type
// or optionality changed rather than disappeared. Both are needed; neither subsumes the other.
type ProviderRequestSchemaOutput = z.infer<typeof providerRequestSchema>;
type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : never) : never;
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : never) : never;
const providerRequestSchemaTypesMatch: MutuallyAssignable<ProviderRequest, ProviderRequestSchemaOutput> = true;
const providerRequestSchemaFieldsMatch: SameKeys<ProviderRequest, ProviderRequestSchemaOutput> = true;
void providerRequestSchemaTypesMatch;
void providerRequestSchemaFieldsMatch;

interface ProviderServerSpecBase {
  provider: string;
  command: string;
  args: string[];
  cwd?: CanonicalWorkDir;
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
        /**
         * What retires an unpinned shared host. `'host-reported'` retires it once the host itself
         * reports no live controllers and no active turns; `'none'` keeps it until an explicit
         * shutdown, so idleness alone never ends its lifetime.
         */
        idleRetirement: 'host-reported' | 'none';
      }
    | {
        leaseMode: 'job-exclusive';
        idleRetirement?: never;
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

export type ProviderInterruptRequestOutcome =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'not-accepted'; reason: string }>;

export type ProviderTurnTerminalEvidence = Readonly<{
  kind: 'provider-turn-terminal';
  providerTurnId: string;
  status: 'interrupted' | 'completed' | 'failed';
}>;

export interface AppServerSession extends AppServerTransport {
  interrupt(continuity: ProviderContinuityBlob): Promise<ProviderInterruptRequestOutcome>;
}

export type ProviderCurationRequest = {
  readonly cwd: CanonicalWorkDir;
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
export interface ProviderCurationCapability<Access extends ProviderAccess> {
  prepare(
    request: ProviderCurationRequest,
    runtime: ProviderCurationPreparationRuntime & { readonly access: Access },
  ): ProviderPreparedCuration;
  isUsageBudgetExhausted(runtime: ProviderCurationUsageRuntime & { readonly access: Access }): boolean;
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

/**
 * Why an operation was stopped mid-flight rather than deliberately ended. Only these two leave the turn cut
 * off, so only these two may record an interruption; every other cause is a stop the user or the system
 * chose, and documenting harm that never happened would be a lie in the journal.
 */
export const PROVIDER_INTERRUPTION_CAUSES = ['restart', 'handoff'] as const;
export type ProviderInterruptionCause = (typeof PROVIDER_INTERRUPTION_CAUSES)[number];

/**
 * Every cause `operation.stop.v1` accepts. Derived from `abortReasons` rather than restated, so "the
 * deliberate stop causes are exactly the abort reasons" is structural: a fourth abort reason joins this set
 * by construction instead of silently diverging from a second flat list somewhere else.
 *
 * It lives here because both sides of the wire may reach `providers/` and neither may reach the other — the
 * proxy is barred from `jobs/`, and a `jobs/`-to-proxy edge would point the dependency the wrong way.
 */
export const PROVIDER_STOP_CAUSES = [...PROVIDER_INTERRUPTION_CAUSES, ...abortReasons] as const;
export type ProviderStopCause = (typeof PROVIDER_STOP_CAUSES)[number];
export const providerStopCauseSchema = z.enum(PROVIDER_STOP_CAUSES);

/** Whether a stop cause is a deliberate abort, and therefore records no interruption. */
export function isAbortStopCause(cause: ProviderStopCause): cause is AbortReason {
  return (abortReasons as readonly string[]).includes(cause);
}

/** Whether a stop cause left the turn cut off, and therefore owes the job a truthful `session.interrupted`. */
export function isInterruptionStopCause(cause: ProviderStopCause): cause is ProviderInterruptionCause {
  return (PROVIDER_INTERRUPTION_CAUSES as readonly string[]).includes(cause);
}

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
    onProviderTurnTerminal(evidence: ProviderTurnTerminalEvidence): void;
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

type ProviderHostPlanningContext<Access extends ProviderAccess> = Readonly<{
  access: Access;
  baseEnv: Readonly<Record<string, string>>;
  platform: string;
  storage: Pick<StoragePort, 'existsSync'>;
}>;

export type ProviderHostPlanningInput<Access extends ProviderAccess = ProviderAccess> =
  | (ProviderHostPlanningContext<Access> &
      Readonly<{
        purpose: 'execution';
        request: ProviderRequest;
        persistedContinuity?: ProviderContinuityBlob;
      }>)
  | (ProviderHostPlanningContext<Access> &
      Readonly<{
        purpose: 'curation';
        request: ProviderCurationRequest;
      }>);

export interface ProviderAppServerCapability<
  Plan extends ProviderExecutionPlan = ProviderExecutionPlan,
  Access extends ProviderAccess = ProviderAccess,
> {
  readonly name: string;
  planHost(input: ProviderHostPlanningInput<Access>): Plan['host'];
  compileStableHost(host: Plan['host']): ProviderServerSpec;
  interrupt?(session: AppServerTransport, continuity: ProviderContinuityBlob): Promise<ProviderInterruptRequestOutcome>;
  probe?(
    session: AppServerTransport,
    continuity: ProviderContinuityBlob,
    context: Readonly<{ request: Pick<ProviderRequest, 'cwd'> }>,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  onNotification?(message: AppServerNotificationMessage): void;
}

export interface ProviderRecoveryContract<Access extends ProviderAccess = ProviderAccess> {
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
    access: Access;
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
export type ProviderPreflightRuntime<Access extends ProviderAccess = ProviderAccess> = PreflightRuntime & {
  access: Access;
  cwd: string;
  runExact(command: string, args: string[], options?: { timeout?: number; encoding?: 'utf-8' }): Promise<ExecResult>;
};
export type ProviderPreflightInput<Access extends ProviderAccess = ProviderAccess> = PreflightRuntime & {
  access: Access;
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

export const PROVIDER_ARTIFACT_DISCARD_PROTOCOL = 'provider-artifact-discard.v1' as const;

export type ProviderArtifactDiscardReconciliation =
  | { readonly kind: 'applied'; readonly outcome: DiscardOutcome }
  | { readonly kind: 'not-applied' }
  | { readonly kind: 'definitive-failure'; readonly reason: string }
  | { readonly kind: 'unknown' };

/** Fail-closed provider action identity or payload contradiction. */
export class ProviderArtifactProtocolInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderArtifactProtocolInvariantError';
  }
}

/** Provider-certified failure that is safe to record as a terminal discard outcome. */
export class ProviderArtifactDefinitiveFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderArtifactDefinitiveFailure';
  }
}

export interface ProviderManagedArtifactCapability<Access extends ProviderAccess = ProviderAccess> {
  readonly kind: 'managed';
  readonly protocol: typeof PROVIDER_ARTIFACT_DISCARD_PROTOCOL;
  discardArtifacts(options: {
    handles: readonly ProviderArtifactHandle[];
    actionId: string;
    payloadHash: string;
    access: Access;
    runtime: ArtifactCleanupRuntime;
  }): Promise<DiscardOutcome>;
  reconcileDiscard(options: {
    handles: readonly ProviderArtifactHandle[];
    actionId: string;
    payloadHash: string;
    access: Access;
    runtime: ArtifactCleanupRuntime;
  }): Promise<ProviderArtifactDiscardReconciliation>;
  /**
   * Best-effort terminal-time fallback. In-run handle emission can miss the
   * native artifact when the provider has not yet flushed it to disk. At
   * discard time — well after the turn, when the file is durably written — the
   * retention reactor re-locates it from the session's persisted
   * conversationRef so cleanup does not silently skip.
   */
  locateArtifact?(options: {
    conversationRef: string;
    access: Access;
    runtime: ArtifactCleanupRuntime;
  }): ProviderArtifactHandle | null;
}

export interface ProviderNoArtifactCapability {
  readonly kind: 'none';
  readonly reason: string;
}

export type ProviderArtifactCapability<Access extends ProviderAccess = ProviderAccess> =
  | ProviderManagedArtifactCapability<Access>
  | ProviderNoArtifactCapability;

type ProviderExecutionPreparationContext<Access extends ProviderAccess> = {
  access: Access;
  request: ProviderRequest;
  persistedContinuity?: ProviderContinuityBlob;
  baseEnv: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  platform: string;
  storage: Pick<StoragePort, 'existsSync'>;
};

type ProviderAppServerPlanPreparation<Plan extends ProviderExecutionPlan, Access extends ProviderAccess> = (
  input: ProviderExecutionPreparationContext<Access> & { hostPlan: Plan['host'] },
) => {
  readonly session: Plan['session'];
  readonly turn: Plan['turn'];
};

type ProviderStandalonePlanPreparation<Plan extends ProviderExecutionPlan, Access extends ProviderAccess> = (
  input: ProviderExecutionPreparationContext<Access>,
) => {
  readonly plan: Plan;
  prepareCliRequest(request: ProviderCliRequest): ProviderCliRequest;
};

type ProviderImplementationCommon<Access extends ProviderAccess> = {
  readonly name: string;
  readonly preflight?: (input: ProviderPreflightInput<Access>) => Promise<void>;
  readonly recovery?: ProviderRecoveryContract<Access>;
};

export type ProviderAppServerImplementation<
  Plan extends ProviderExecutionPlan,
  Access extends ProviderAccess = ProviderAccess,
> = ProviderImplementationCommon<Access> & {
  readonly transport: 'app-server';
  readonly run: ProviderAppServer<Plan>;
  readonly appServer: ProviderAppServerCapability<Plan, Access>;
  readonly prepareExecutionPlan: ProviderAppServerPlanPreparation<Plan, Access>;
  readonly curation?: ProviderCurationCapability<Access>;
};

export type ProviderStandaloneImplementation<
  Plan extends ProviderExecutionPlan,
  Access extends ProviderAccess = ProviderAccess,
> = ProviderImplementationCommon<Access> & {
  readonly transport: 'standalone';
  readonly run: ProviderStandalone<Plan>;
  readonly prepareExecutionPlan: ProviderStandalonePlanPreparation<Plan, Access>;
};

export type ProviderImplementation<
  Plan extends ProviderExecutionPlan,
  Access extends ProviderAccess = ProviderAccess,
> = ProviderAppServerImplementation<Plan, Access> | ProviderStandaloneImplementation<Plan, Access>;

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
