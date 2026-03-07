import type { ProviderProgressEvent, ProviderRequest, ProviderResult } from '../types.js';

/** MCP progress notification sender injected into provider handlers. */
export type NotifyFn = (n: { method: string; params: Record<string, unknown> }) => Promise<void>;

/** MCP tool descriptor exposed by a provider (name, description, inputSchema). */
export type ProviderTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

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
