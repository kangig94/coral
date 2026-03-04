import type { OnEventCallback } from '../runner/job-manager.js';
import type { SessionManager } from '../runner/session-manager.js';
import type { CompletionMetadata } from '../runner/types.js';
import type { McpResult } from '../shared/mcp-utils.js';

/** MCP progress notification sender injected into provider handlers. */
export type NotifyFn = (n: { method: string; params: Record<string, unknown> }) => Promise<void>;

/** MCP tool descriptor exposed by a provider (name, description, inputSchema). */
export type ProviderTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Contract that every provider adapter must implement.
 * Register adapters via `registerProvider()` in `providers/registry.ts`.
 * `name` must equal `tool.name` and must not conflict with reserved names ("wait", "workflow").
 */
export type ProviderAdapter = {
  name: string;
  tool: ProviderTool;
  handleOp(
    rawArgs: Record<string, unknown>,
    mgr: SessionManager,
    progressToken?: string | number,
    notify?: NotifyFn,
  ): Promise<McpResult>;
  handleCoralOp(
    coralName: string,
    coralContent: string,
    rawArgs: Record<string, unknown>,
    mgr: SessionManager,
    progressToken?: string | number,
    notify?: NotifyFn,
  ): Promise<McpResult>;
  extractCompletion(result: McpResult): {
    responseText: string;
    metadata: CompletionMetadata;
    sessionId?: string;
  };
  makeOnEvent(ctx: { progressFile: string }): OnEventCallback;
};
