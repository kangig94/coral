import type { ProviderContinuityBlob, ProviderProgressEvent, ProviderRequest, ProviderResult } from '../shared/types.js';
import { nowIsoString } from '../shared/utils.js';
import type { ProviderCliRunner } from './runner-port.js';

export type { ProviderContinuityBlob } from '../shared/types.js';

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
  }): Promise<ProviderResult>;

  /**
   * Build recovery metadata to persist at launch time.
   * Called by the executor before spawning; stored in runtime.json.providerMeta.
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

/** Build an onEvent callback that parses JSON lines and emits ProviderProgressEvents. */
export function makeOnEvent<TEvent>(
  runtime: ProviderRuntime,
  jobId: string,
  extractor: (event: TEvent, projectRoot?: string) => string | null,
  projectRoot?: string,
): (line: string) => void {
  return (line: string) => {
    try {
      const event = JSON.parse(line) as TEvent;
      const message = extractor(event, projectRoot);
      if (!message) return;
      const progressEvent: ProviderProgressEvent = { jobId, message, ts: nowIsoString() };
      runtime.onEvent(progressEvent);
    } catch {
      /* ignore non-JSON or unparseable lines */
    }
  };
}

/** Runtime context injected by the ExecutionService into Provider.execute(). */
export interface ProviderRuntime {
  signal: AbortSignal;
  onEvent: (event: ProviderProgressEvent) => void;
  runCli: ProviderCliRunner;
  acquireServer?: (spec: ProviderServerSpec) => Promise<ProviderServerLease>;
  persistedContinuity?: ProviderContinuityBlob;
  checkpointRecovery?: (update: {
    conversationRef?: string;
    providerMeta: ProviderRecoveryMeta;
  }) => void;
}

export interface Provider {
  name: string;
  execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult>;
  /** Optional preflight check: auth/availability. Throw to reject launch before jobId is allocated. */
  preflight?(): Promise<void>;
  /** Recovery contract for durable execution handoff. */
  recovery?: ProviderRecoveryContract;
  appServer?: ProviderAppServerContract;
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
