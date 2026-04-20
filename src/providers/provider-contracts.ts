import type { ProviderContinuityBlob } from '../sessions/continuity.js';
import type { ProviderProgressEventBody, ProviderRequest, ProviderTerminalEventBody, ProviderEventBody } from './protocol.js';
import type { Runtime } from '../runtime/ports.js';
import { nowIsoString } from '../shared/utils.js';
import type { ProviderCliRunner } from './runner-port.js';

export type { ProviderContinuityBlob } from '../sessions/continuity.js';

/** Recovery metadata persisted at launch time by the provider. */
export interface ProviderRecoveryMeta {
  /** Provider-specific key-value data needed for recovery. */
  [key: string]: unknown;
}

export interface ProviderServerSpec {
  provider: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  shared?: boolean;
  /** If set, engine sends this JSON-RPC request immediately after spawn and awaits the response before returning the lease. */
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

export interface ProviderAppServerContract {
  buildServerSpec(
    persistedContinuity: ProviderContinuityBlob | undefined,
    request: ProviderRequest,
  ): ProviderServerSpec;
  interrupt(lease: ProviderServerLease, continuity: ProviderContinuityBlob): Promise<void>;
  probe(
    lease: ProviderServerLease,
    continuity: ProviderContinuityBlob,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  finalizeInterrupted(
    probeResult: { resumable: boolean; updatedContinuity?: ProviderContinuityBlob },
    continuity: ProviderContinuityBlob,
  ): {
    conversationRef?: string;
    nonResumable?: boolean;
    continuityMutation?: ProviderContinuityBlob;
  };
  /** Migrate legacy runtime meta to the provider continuity blob format. */
  migrateLegacyContinuity?(meta: Record<string, unknown>): ProviderContinuityBlob | undefined;
}

/** Contract for provider-owned recovery after backend replacement. */
export interface ProviderRecoveryContract {
  /**
   * Finalize a terminal result from durable artifacts (stdout file, exit record).
   * Used both for live completion (wrapper exit) and recovered completion (adoption).
   */
  finalizeFromArtifacts(options: {
    stdoutPath: string;
    stderrPath: string;
    exitCode: number | null;
    signal: string | null;
    providerMeta?: Record<string, unknown>;
    fallbackConversationRef?: string;
  }): Promise<ProviderTerminalEventBody>;

  /**
   * Build recovery metadata to persist at launch time.
   * Called by the executor before spawning; stored in the journal runtime projection.
   */
  buildRecoveryMeta?(request: ProviderRequest): ProviderRecoveryMeta;

  /**
   * Extract progress from a raw stdout file starting at a byte offset.
   * Used to reattach live progress for adopted running jobs.
   * Returns extracted messages and the new byte offset watermark.
   */
  extractProgress?(options: { stdoutPath: string; fromOffset: number; providerMeta?: Record<string, unknown> }): {
    messages: string[];
    newOffset: number;
  };
}

/** Build an onEvent callback that parses JSON lines and emits ProviderTurnProgressEvents. */
export function makeOnEvent<TEvent>(
  emit: (event: ProviderProgressEventBody) => void,
  extractor: (event: TEvent, projectRoot?: string) => string | null,
  projectRoot?: string,
): (line: string) => void {
  return (line: string) => {
    try {
      const event = JSON.parse(line) as TEvent;
      const message = extractor(event, projectRoot);
      if (!message) return;
      emit({ type: 'launch.progress', message, ts: nowIsoString() });
    } catch {
      /* ignore non-JSON or unparseable lines */
    }
  };
}

/** Runtime context injected by the ExecutionService into Provider.execute(). */
export interface ProviderRuntime {
  signal: AbortSignal;
  runCli: ProviderCliRunner;
  storage?: Pick<Runtime['storage'], 'readFileSync'>;
  env?: Pick<Runtime['env'], 'homedir'>;
  acquireServer?: (spec: ProviderServerSpec) => Promise<ProviderServerLease>;
  persistedContinuity?: ProviderContinuityBlob;
  checkpointRecovery?: (update: {
    conversationRef?: string;
    providerMeta: ProviderRecoveryMeta;
  }) => void;
}

export type PreflightRuntime = Pick<Runtime, 'process' | 'storage' | 'env'>;

/** Minimal runtime surface for post-workflow artifact cleanup. */
export type ArtifactCleanupRuntime = Pick<Runtime, 'storage' | 'env'>;

export interface ProviderExecutor {
  readonly name: string;
  execute(request: ProviderRequest, runtime: ProviderRuntime): AsyncIterable<ProviderEventBody>;
  /** Optional preflight check: auth/availability. Throw to reject launch before jobId is allocated. */
  preflight?(runtime: PreflightRuntime): Promise<void>;
}

/**
 * Alias of ProviderAppServerContract, named for the consumer seam (app-server lifecycle).
 * Intentionally a plain alias, not an extension: no consumer reads a `role.name` field
 * because callers already have `providerName` in scope via `launchRecord.provider` or a
 * parameter. Aliasing avoids a drift surface where `role.name` could disagree with the
 * registry key.
 */
export type ProviderAppServerLifecycle = ProviderAppServerContract;

/**
 * Alias of ProviderRecoveryContract, named for the consumer seam (durable-artifact recovery).
 * See ProviderAppServerLifecycle for the rationale behind aliasing instead of extending.
 */
export type ProviderArtifactRecovery = ProviderRecoveryContract;

export interface ProviderArtifactCleanup {
  readonly name: string;
  cleanupSessions(runtime: ArtifactCleanupRuntime, conversationRefs: readonly string[]): Promise<void>;
}

export interface Provider extends ProviderExecutor {
  appServerLifecycle?: ProviderAppServerLifecycle;
  artifactRecovery?: ProviderArtifactRecovery;
  artifactCleanup?: ProviderArtifactCleanup;
}

export function requireConversationRef(request: ProviderRequest, action: 'resume' | 'fork'): string {
  if (!request.conversationRef) throw new Error(`${action} requires conversationRef`);
  return request.conversationRef;
}

export function requireAppServerRuntime(
  runtime: ProviderRuntime,
  providerName: string,
): {
  acquireServer: NonNullable<ProviderRuntime['acquireServer']>;
  checkpointRecovery: NonNullable<ProviderRuntime['checkpointRecovery']>;
} {
  if (!runtime.acquireServer) {
    throw new Error(`${providerName} provider requires ProviderRuntime.acquireServer().`);
  }
  if (!runtime.checkpointRecovery) {
    throw new Error(`${providerName} provider requires ProviderRuntime.checkpointRecovery().`);
  }
  return {
    acquireServer: runtime.acquireServer,
    checkpointRecovery: runtime.checkpointRecovery,
  };
}
