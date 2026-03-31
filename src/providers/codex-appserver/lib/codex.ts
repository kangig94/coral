import type {
  AppServerNotification,
  ReviewTarget,
  ThreadItem,
  ThreadResumeParams,
  ThreadStartParams,
  Turn,
  UserInput
} from "./app-server-protocol.js";
import { readJsonFile } from "./fs.js";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.js";
import { loadBrokerSession } from "./broker-lifecycle.js";
import { binaryAvailable, runCommand } from "./process.js";

type ProgressReporter = (update: string | {
  message: string;
  phase: string | null;
  threadId?: string | null;
  turnId?: string | null;
  stderrMessage?: string | null;
  logTitle?: string | null;
  logBody?: string | null;
}) => void;

interface TurnCaptureState {
  threadId: string;
  rootThreadId: string;
  threadIds: Set<string>;
  threadTurnIds: Map<string, string>;
  threadLabels: Map<string, string>;
  turnId: string | null;
  bufferedNotifications: AppServerNotification[];
  completion: Promise<TurnCaptureState>;
  resolveCompletion: (state: TurnCaptureState) => void;
  rejectCompletion: (error: unknown) => void;
  finalTurn: Turn | null;
  completed: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<typeof setTimeout> | null;
  lastAgentMessage: string;
  reviewText: string;
  reasoningSummary: string[];
  error: unknown;
  messages: Array<{ lifecycle: string; phase: string | null; text: string }>;
  fileChanges: ThreadItem[];
  commandExecutions: ThreadItem[];
  onProgress: ProgressReporter | null;
}

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

function cleanCodexStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

function buildThreadParams(cwd: string, options: {
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
  ephemeral?: boolean;
} = {}): ThreadStartParams {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true,
    experimentalRawEvents: false
  } as ThreadStartParams;
}

function buildResumeParams(threadId: string, cwd: string, options: {
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
} = {}): ThreadResumeParams {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  } as ThreadResumeParams;
}

function buildTurnInput(prompt: string): UserInput[] {
  return [{ type: "text", text: prompt, text_elements: [] } as UserInput];
}

function shorten(text: unknown, limit = 72): string {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command: string): boolean {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt: string): string {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message: AppServerNotification): string | null {
  return (message as unknown as { params?: { threadId?: string } })?.params?.threadId ?? null;
}

function extractTurnId(message: AppServerNotification): string | null {
  const params = (message as unknown as { params?: { turnId?: string; turn?: { id?: string } } })?.params;
  if (params?.turnId) {
    return params.turnId;
  }
  if (params?.turn?.id) {
    return params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges: ThreadItem[]): string[] {
  const paths = new Set<string>();
  for (const fileChange of fileChanges) {
    for (const change of (fileChange as unknown as { changes?: { path?: string }[] }).changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return extractReasoningSections(obj.text);
    }
    if ("summary" in obj) {
      return extractReasoningSections(obj.summary);
    }
    if ("content" in obj) {
      return extractReasoningSections(obj.content);
    }
    if ("parts" in obj) {
      return extractReasoningSections(obj.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections: string[], nextSections: string[]): string[] {
  const merged: string[] = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

function emitProgress(
  onProgress: ProgressReporter | null | undefined,
  message: string | null | undefined,
  phase: string | null = null,
  extra: Record<string, unknown> = {}
): void {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress: ProgressReporter | null | undefined, options: {
  message?: string;
  phase?: string | null;
  stderrMessage?: string | null;
  logTitle?: string | null;
  logBody?: string | null;
} = {}): void {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state: TurnCaptureState, threadId: string | null): string | null {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state: TurnCaptureState, threadId: string | null, options: {
  threadName?: string | null;
  name?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
} = {}): void {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ThreadItem subtypes are dynamic */

function describeStartedItem(state: TurnCaptureState, item: any): { message: string; phase: string } | null {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId: string) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state: TurnCaptureState, item: any): { message: string; phase: string } | null {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId: string) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

function createTurnCaptureState(threadId: string, options: { onProgress?: ProgressReporter | null } = {}): TurnCaptureState {
  let resolveCompletion!: (state: TurnCaptureState) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<TurnCaptureState>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state: TurnCaptureState): void {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state: TurnCaptureState, turn: Turn | null = null, options: { inferred?: boolean } = {}): void {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    } as Turn;
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state: TurnCaptureState): void {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state: TurnCaptureState, message: AppServerNotification): boolean {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ThreadItem/notification params are dynamic */

function recordItem(state: TurnCaptureState, item: any, lifecycle: string, threadId: string | null = null): void {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state: TurnCaptureState, message: AppServerNotification): void {
  const msg = message as any;
  switch (msg.method) {
    case "thread/started":
      registerThread(state, msg.params.thread.id, {
        threadName: msg.params.thread.name,
        name: msg.params.thread.name,
        agentNickname: msg.params.thread.agentNickname,
        agentRole: msg.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, msg.params.threadId, {
        threadName: msg.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, msg.params.threadId);
      state.threadTurnIds.set(msg.params.threadId, msg.params.turn.id);
      if ((msg.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(msg.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${msg.params.turn.id}).`,
        "starting",
        (msg.params.threadId ?? null) === state.threadId
          ? {
              threadId: msg.params.threadId ?? null,
              turnId: msg.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, msg.params.item, "started", msg.params.threadId ?? null);
      {
        const update = describeStartedItem(state, msg.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, msg.params.item, "completed", msg.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, msg.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = msg.params.error;
      emitProgress(state.onProgress, `Codex error: ${msg.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((msg.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(msg.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${msg.params.turn.status === "completed" ? "completed" : msg.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, msg.params.turn);
      break;
    default:
      break;
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

interface AppServerClient {
  notificationHandler: ((message: AppServerNotification) => void) | null;
  transport: string;
  stderr: string;
  setNotificationHandler(handler: ((message: AppServerNotification) => void) | null): void;
  request(method: string, params: unknown): Promise<any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): Promise<void>;
}

async function captureTurn(
  client: AppServerClient,
  threadId: string,
  startRequest: () => Promise<any>,  // eslint-disable-line @typescript-eslint/no-explicit-any
  options: {
    onProgress?: ProgressReporter | null;
    onResponse?: (response: any, state: TurnCaptureState) => void;  // eslint-disable-line @typescript-eslint/no-explicit-any
  } = {}
): Promise<TurnCaptureState> {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message: AppServerNotification) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if ((message as any).method === "thread/started" || (message as any).method === "thread/name/updated") {  // eslint-disable-line @typescript-eslint/no-explicit-any
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    applyTurnNotification(state, message);
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer<T>(cwd: string, fn: (client: AppServerClient) => Promise<T>): Promise<T> {
  let client: AppServerClient | null = null;
  try {
    client = await CodexAppServerClient.connect(cwd) as unknown as AppServerClient;
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const err = error as { rpcCode?: number; code?: string };
    const shouldRetryDirect =
      (client?.transport === "broker" && err?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (err?.code === "ENOENT" || err?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true }) as unknown as AppServerClient;
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function startThread(client: AppServerClient, cwd: string, options: {
  model?: string | null;
  sandbox?: string;
  ephemeral?: boolean;
  threadName?: string | null;
} = {}): Promise<any> {  // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = (response).thread.id;   
  if (options.threadName) {
    await client.request("thread/name/set", { threadId, name: options.threadName });
  }
  return response;
}

async function resumeThread(client: AppServerClient, threadId: string, cwd: string, options: {
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
} = {}): Promise<unknown> {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState: TurnCaptureState): number {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

export function getCodexAvailability(cwd: string): { available: boolean; detail: string } {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): {
  mode: string;
  label: string;
  detail: string;
  endpoint: string | null;
} {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export function getCodexLoginStatus(cwd: string): { available: boolean; loggedIn: boolean; detail: string } {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail
    };
  }

  const result = runCommand("codex", ["login", "status"], { cwd });
  if (result.error) {
    return {
      available: true,
      loggedIn: false,
      detail: result.error.message
    };
  }

  if (result.status === 0) {
    return {
      available: true,
      loggedIn: true,
      detail: result.stdout.trim() || "authenticated"
    };
  }

  return {
    available: true,
    loggedIn: false,
    detail: result.stderr.trim() || result.stdout.trim() || "not authenticated"
  };
}

export async function interruptAppServerTurn(cwd: string, { threadId, turnId }: { threadId: string | null; turnId: string | null }): Promise<{
  attempted: boolean;
  interrupted: boolean;
  transport: string | null;
  detail: string;
}> {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  const brokerEndpoint = process.env[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  let client: AppServerClient | null = null;
  try {
    client = brokerEndpoint
      ? await CodexAppServerClient.connect(cwd, { brokerEndpoint }) as unknown as AppServerClient
      : await CodexAppServerClient.connect(cwd, { disableBroker: true }) as unknown as AppServerClient;
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd: string, options: {
  target?: ReviewTarget;
  model?: string | null;
  threadName?: string;
  delivery?: string;
  onProgress?: ProgressReporter | null;
} = {}): Promise<{
  status: number;
  threadId: string;
  sourceThreadId: string;
  turnId: string | null;
  reviewText: string;
  reasoningSummary: string[];
  turn: Turn | null;
  error: unknown;
  stderr: string;
}> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        onResponse(response: any, state: TurnCaptureState) {  // eslint-disable-line @typescript-eslint/no-explicit-any
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd: string, options: {
  resumeThreadId?: string | null;
  prompt?: string;
  defaultPrompt?: string;
  model?: string | null;
  effort?: string | null;
  sandbox?: string;
  onProgress?: ProgressReporter | null;
  persistThread?: boolean;
  threadName?: string | null;
  outputSchema?: unknown;
} = {}): Promise<{
  status: number;
  threadId: string;
  turnId: string | null;
  finalMessage: string;
  reasoningSummary: string[];
  turn: Turn | null;
  error: unknown;
  stderr: string;
  fileChanges: ThreadItem[];
  touchedFiles: string[];
  commandExecutions: ThreadItem[];
}> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    let threadId: string;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      } as any);  // eslint-disable-line @typescript-eslint/no-explicit-any
      threadId = (response as any).thread.id;  // eslint-disable-line @typescript-eslint/no-explicit-any
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null
        }),
      { onProgress: options.onProgress }
    );

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  });
}

export async function findLatestTaskThread(cwd: string): Promise<{ id: string; name?: string } | null> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      (response).data.find((thread: { name?: string }) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??   
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt: string): string {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput: string | null | undefined, fallback: Record<string, unknown> = {}): {
  parsed: unknown;
  parseError: string | null;
  rawOutput: string;
  [key: string]: unknown;
} {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: (fallback.failureMessage as string) ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: (error as Error).message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath: string): unknown {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
