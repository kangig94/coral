import type { ProviderProgressEvent, ProviderRequest, ProviderResult } from '../types.js';

/** Build an onEvent callback that parses JSON lines and emits ProviderProgressEvents. */
export function makeOnEvent(
  runtime: ProviderRuntime,
  jobId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractor: (event: any, projectRoot?: string) => string | null,
  projectRoot?: string,
): (line: string) => void {
  return (line: string) => {
    try {
      const event: unknown = JSON.parse(line);
      const message = extractor(event, projectRoot);
      if (!message) return;
      const progressEvent: ProviderProgressEvent = { jobId, message, ts: new Date().toISOString() };
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
}

/** Capability flags declared by a provider adapter. */
export interface ProviderCapabilities {
  resumable: boolean;
  forkable: boolean;
}

export interface Provider {
  name: string;
  capabilities: ProviderCapabilities;
  execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult>;
  /** Optional preflight check: auth/availability. Throw to reject launch before jobId is allocated. */
  preflight?(): Promise<void>;
}
