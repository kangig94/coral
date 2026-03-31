import type { ProviderProgressEvent, ProviderRequest, ProviderResult } from '../shared/types.js';
import { nowIsoString } from '../shared/mcp-utils.js';
import type { ProviderCliRunner } from './runner-port.js';

/** Recovery metadata persisted at launch time by the provider. */
export interface ProviderRecoveryMeta {
  /** Provider-specific key-value data needed for recovery. */
  [key: string]: unknown;
}

export interface ProviderServerSpec {
  provider: string;
  key: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  idleTtlMs?: number;
}

export interface ProviderServerLease {
  rpc<R = unknown>(method: string, params: Record<string, unknown>): Promise<R>;
  subscribe(handler: (msg: { method: string; params?: Record<string, unknown> }) => void): () => void;
  release(): void;
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
}

export function requireConversationRef(request: ProviderRequest, action: 'resume' | 'fork'): string {
  if (!request.conversationRef) throw new Error(`${action} requires conversationRef`);
  return request.conversationRef;
}
