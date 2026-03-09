import type { ProviderProgressEvent, ProviderRequest, ProviderResult } from '../types.js';

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

export interface Provider {
  name: string;
  execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult>;
  /** Optional preflight check: auth/availability. Throw to reject launch before jobId is allocated. */
  preflight?(): Promise<void>;
}
