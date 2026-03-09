import { ensureBackend as defaultEnsureBackend, withAbortTimeout, type BackendHandle } from './backend-lifecycle.js';
import type { WaitCursor, WaitStreamEvent } from '../types.js';
import { isRecord } from '../shared/mcp-utils.js';

const TOOL_TIMEOUT_MS = 300_000;
const HEALTH_TIMEOUT_MS = 3_000;
const MAX_WAIT_FETCH_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_FETCH_MARGIN_MS = 30_000;

type SseEventBlock = {
  event?: string;
  data: string;
};

interface ProviderToolOptions {
  context?: CallerContext;
  work_dir?: string;
  model?: string;
  bypass_permissions?: boolean;
  system_prompt?: string;
}

interface WorkflowOptions {
  init_prompt: string;
  context?: string;
  provider?: string;
  work_dir?: string;
  stale_timeout_seconds?: number;
  atoms?: Record<string, { instruction?: string }>;
}

interface WaitOptions {
  timeoutSeconds?: number;
  cursor?: WaitCursor;
  projectRoot?: string;
  signal?: AbortSignal;
}

/**
 * Request-scoped paths the backend needs for job provenance and plugin resolution.
 */
export interface CallerContext {
  projectRoot: string;
  pluginRoot: string;
}

/**
 * Health metadata exposed by the Coral backend.
 */
export interface BackendHealth {
  status: 'ok';
  version: string;
  bundleHash: string;
  instanceId: string;
  uptimeMs: number;
  activeChildren: number;
  activeJobs: number;
  inflightRequests: number;
  queueDepth: number;
}

function isCallerContext(value: unknown): value is CallerContext {
  return isRecord(value)
    && typeof value.projectRoot === 'string'
    && typeof value.pluginRoot === 'string';
}

function isBackendHealth(value: unknown): value is BackendHealth {
  return isRecord(value)
    && value.status === 'ok'
    && typeof value.version === 'string'
    && typeof value.bundleHash === 'string'
    && typeof value.instanceId === 'string'
    && Number.isFinite(value.uptimeMs)
    && Number.isInteger(value.activeChildren)
    && Number.isInteger(value.activeJobs)
    && Number.isInteger(value.inflightRequests)
    && Number.isInteger(value.queueDepth);
}

function describeHttpError(status: number, statusText: string): string {
  if (status === 503) return 'Backend shutting down, retry';
  if (status === 401) return 'Backend auth failure - stale token';
  return `Backend request failed: ${status} ${statusText}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function serializeWaitCursor(cursor: WaitCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function parseWaitStreamEvent(eventType: string | undefined, rawData: string): WaitStreamEvent | null {
  if (!eventType) return null;

  const parsed: unknown = JSON.parse(rawData);
  if (!isRecord(parsed) || parsed.type !== eventType) {
    throw new Error(`Invalid wait stream event payload for ${eventType}`);
  }

  switch (eventType) {
    case 'progress':
      if (
        typeof parsed.jobId === 'string'
        && typeof parsed.sessionId === 'string'
        && Number.isInteger(parsed.eventId)
        && typeof parsed.message === 'string'
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid progress wait stream event');
    case 'terminal':
      if (
        typeof parsed.completedJobId === 'string'
        && typeof parsed.sessionId === 'string'
        && Array.isArray(parsed.remainingJobIds)
        && parsed.remainingJobIds.every((jobId) => typeof jobId === 'string')
        && typeof parsed.resultPath === 'string'
        && isRecord(parsed.result)
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid terminal wait stream event');
    case 'timeout':
      if (
        Array.isArray(parsed.runningJobIds)
        && parsed.runningJobIds.every((jobId) => typeof jobId === 'string')
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid timeout wait stream event');
    case 'queued':
      if (
        typeof parsed.jobId === 'string'
        && typeof parsed.sessionId === 'string'
        && typeof parsed.queuePosition === 'number'
        && Array.isArray(parsed.runningJobIds)
        && parsed.runningJobIds.every((jobId) => typeof jobId === 'string')
      ) {
        return parsed as WaitStreamEvent;
      }
      throw new Error('Invalid queued wait stream event');
    default:
      return null;
  }
}

function parseSseBlock(block: string): SseEventBlock | null {
  if (!block.trim()) return null;

  let event: string | undefined;
  const data: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        data.push(value);
        break;
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/**
 * Typed HTTP wrapper around the Coral backend endpoints used by coral-reef.
 */
export class BackendClient {
  private readonly ensureBackendHandle: () => Promise<BackendHandle>;
  private readonly defaultContext?: CallerContext;

  constructor(options: {
    ensureBackend?: () => Promise<BackendHandle>;
    defaultContext?: CallerContext;
  } = {}) {
    this.ensureBackendHandle = options.ensureBackend ?? defaultEnsureBackend;
    this.defaultContext = options.defaultContext;
  }

  /**
   * Starts a new Codex execution.
   */
  async exec(prompt: string, options: ProviderToolOptions = {}): Promise<unknown> {
    const { context, ...args } = options;
    return this.proxyToolCall('codex', { op: 'exec', prompt, ...args }, this.resolveContext(context));
  }

  /**
   * Resumes an existing Codex session.
   */
  async resume(session: string, prompt: string, options: ProviderToolOptions = {}): Promise<unknown> {
    const { context, ...args } = options;
    return this.proxyToolCall('codex', { op: 'resume', session, prompt, ...args }, this.resolveContext(context));
  }

  /**
   * Forks a Codex session, optionally with a follow-up prompt.
   */
  async fork(source: string, prompt?: string, options: ProviderToolOptions = {}): Promise<unknown> {
    const { context, ...args } = options;
    const request: Record<string, unknown> = { op: 'fork', session: source, ...args };

    if (prompt !== undefined) {
      request.prompt = prompt;
    }

    return this.proxyToolCall('codex', request, this.resolveContext(context));
  }

  /**
   * Aborts a single backend job.
   */
  async abort(jobId: string, context?: CallerContext): Promise<unknown> {
    return this.proxyToolCall('abort', { jobs: [jobId] }, this.resolveContext(context));
  }

  /**
   * Executes a workflow expression through the backend workflow tool.
   */
  async workflow(expression: string, options: WorkflowOptions): Promise<unknown>;
  async workflow(expression: string, context: CallerContext, options: WorkflowOptions): Promise<unknown>;
  async workflow(
    expression: string,
    contextOrOptions: CallerContext | WorkflowOptions,
    maybeOptions?: WorkflowOptions,
  ): Promise<unknown> {
    const callerContext = isCallerContext(contextOrOptions) ? contextOrOptions : undefined;
    const options = callerContext ? maybeOptions : contextOrOptions;

    if (!options) {
      throw new Error('Workflow options are required');
    }

    return this.proxyToolCall('workflow', { expression, ...options }, this.resolveContext(callerContext));
  }

  /**
   * Streams wait events for one or more jobs.
   */
  async *wait(jobIds: string[], options: WaitOptions = {}): AsyncGenerator<WaitStreamEvent> {
    const { timeoutSeconds, cursor, projectRoot, signal } = options;
    const resolvedProjectRoot = projectRoot ?? this.defaultContext?.projectRoot;

    if (!resolvedProjectRoot) {
      throw new Error('projectRoot is required for wait');
    }

    const { port, token } = await this.ensureBackendHandle();
    const fetchTimeoutMs = Math.min(
      (timeoutSeconds ?? 600) * 1000 + WAIT_FETCH_MARGIN_MS,
      MAX_WAIT_FETCH_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/wait/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Coral-Backend-Token': token,
          ...(cursor ? { 'Last-Event-ID': serializeWaitCursor(cursor) } : {}),
        },
        body: JSON.stringify({
          jobIds,
          timeoutSeconds,
          projectRoot: resolvedProjectRoot,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await parseJsonResponse(response);
        const message = isRecord(body) && typeof body.message === 'string'
          ? body.message
          : describeHttpError(response.status, response.statusText);
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error('Backend wait stream returned no response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      for await (const chunk of response.body) {
        const decoded = decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        buffer += decoded;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          const event = parseWaitStreamEvent(parsed.event, parsed.data);
          if (event) yield event;
        }
      }

      buffer += decoder.decode();
      const finalBlock = parseSseBlock(buffer.replace(/\r\n/g, '\n'));
      if (!finalBlock) return;

      const finalEvent = parseWaitStreamEvent(finalBlock.event, finalBlock.data);
      if (finalEvent) yield finalEvent;
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Backend communication error: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Returns backend health metadata when the daemon responds with a valid payload.
   */
  async health(): Promise<BackendHealth | null> {
    const { port, token } = await this.ensureBackendHandle();

    try {
      const response = await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) => fetch(`http://127.0.0.1:${port}/health`, {
        method: 'GET',
        headers: { 'X-Coral-Backend-Token': token },
        signal,
      }));

      if (!response.ok) {
        return null;
      }

      const body = await parseJsonResponse(response);
      return isBackendHealth(body) ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Requests backend shutdown.
   */
  async shutdown(): Promise<{ ok: boolean }> {
    const { port, token } = await this.ensureBackendHandle();

    try {
      const response = await withAbortTimeout(HEALTH_TIMEOUT_MS, (signal) => fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
        method: 'POST',
        headers: { 'X-Coral-Backend-Token': token },
        signal,
      }));

      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Lists the tool descriptors currently served by the backend.
   */
  async listTools(): Promise<unknown> {
    const { port, token } = await this.ensureBackendHandle();

    try {
      return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
        const response = await fetch(`http://127.0.0.1:${port}/tools`, {
          method: 'GET',
          headers: { 'X-Coral-Backend-Token': token },
          signal,
        });

        if (!response.ok) {
          throw new Error(describeHttpError(response.status, response.statusText));
        }

        return parseJsonResponse(response);
      });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Backend communication error: ${String(error)}`);
    }
  }

  private resolveContext(context?: CallerContext): CallerContext {
    if (context) {
      return context;
    }

    if (this.defaultContext) {
      return this.defaultContext;
    }

    throw new Error('CallerContext is required for backend tool calls');
  }

  private async proxyToolCall(
    name: string,
    args: Record<string, unknown>,
    ctx: CallerContext,
  ): Promise<unknown> {
    const { port, token } = await this.ensureBackendHandle();
    const body = JSON.stringify({
      name,
      args,
      context: {
        projectRoot: ctx.projectRoot,
        pluginRoot: ctx.pluginRoot,
      },
    });

    try {
      return await withAbortTimeout(TOOL_TIMEOUT_MS, async (signal) => {
        const response = await fetch(`http://127.0.0.1:${port}/tool`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': token,
          },
          body,
          signal,
        });

        if (!response.ok) {
          throw new Error(describeHttpError(response.status, response.statusText));
        }

        return parseJsonResponse(response);
      });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Backend communication error: ${String(error)}`);
    }
  }
}
