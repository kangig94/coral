import type { ProviderProgressEvent, ProviderRequest, ProviderResult } from '../shared/types.js';
import { nowIsoString } from '../shared/mcp-utils.js';

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
}

export interface Provider {
  name: string;
  execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult>;
  /** Optional preflight check: auth/availability. Throw to reject launch before jobId is allocated. */
  preflight?(): Promise<void>;
}

export function requireConversationRef(request: ProviderRequest, action: 'resume' | 'fork'): string {
  if (!request.conversationRef) throw new Error(`${action} requires conversationRef`);
  return request.conversationRef;
}
