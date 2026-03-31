// --- Inlined types from .generated/app-server-types/index.js ---

export interface ClientInfo {
  title: string;
  name: string;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  optOutNotificationMethods: string[];
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities;
}

export interface InitializeResponse {
  userAgent?: string;
}

export interface ServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

// --- Inlined types from .generated/app-server-types/v2/index.js ---

export interface UserInput {
  type: string;
  text: string;
  text_elements: unknown[];
}

export interface ReviewTarget {
  mode: string;
  label: string;
  baseRef?: string;
  explicit?: boolean;
}

export interface ReviewStartParams {
  threadId: string;
  delivery: string;
  target?: ReviewTarget;
}

export interface ReviewStartResponse {
  reviewThreadId?: string;
  turn?: Turn;
}

export interface ThreadInfo {
  id: string;
  name?: string;
  agentNickname?: string;
  agentRole?: string;
}

export interface Thread {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  agentNickname?: string;
  agentRole?: string;
}

export interface ThreadItemChange {
  path?: string;
  [key: string]: unknown;
}

export interface ThreadItem {
  id?: string;
  type: string;
  status?: string;
  changes?: ThreadItemChange[];
  command?: string;
  exitCode?: number;
  text?: string;
  phase?: string;
  review?: string;
  summary?: unknown;
  tool?: string;
  server?: string;
  query?: string;
  receiverThreadIds?: string[];
  [key: string]: unknown;
}

export interface ThreadListParams {
  cwd?: string;
  limit?: number;
  sortKey?: string;
  sourceKinds?: string[];
  searchTerm?: string;
}

export interface ThreadListResponse {
  data: Thread[];
}

interface RawThreadStartParams {
  cwd: string;
  model: string | null;
  approvalPolicy: string;
  sandbox: string;
  serviceName?: string;
  ephemeral?: boolean;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
}

export interface ThreadStartResponse {
  thread: ThreadInfo;
  turn?: Turn;
}

interface RawThreadResumeParams {
  threadId: string;
  cwd: string;
  model: string | null;
  approvalPolicy: string;
  sandbox: string;
  persistExtendedHistory?: boolean;
}

export interface ThreadResumeResponse {
  thread: ThreadInfo;
}

export interface ThreadSetNameParams {
  threadId: string;
  name: string;
}

export interface ThreadSetNameResponse {
  threadId: string;
  name: string;
}

export interface Turn {
  id: string;
  status?: string;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string | null;
  effort?: string | null;
  outputSchema?: unknown;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnInterruptResponse {
  threadId: string;
  turnId: string;
}

// --- Derived types (from original .d.ts) ---

export type ThreadStartParams = Omit<RawThreadStartParams, "persistExtendedHistory">;
export type ThreadResumeParams = Omit<RawThreadResumeParams, "persistExtendedHistory">;

export interface CodexAppServerClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities;
  brokerEndpoint?: string;
  disableBroker?: boolean;
}

export interface AppServerMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; result: ThreadResumeResponse };
  "thread/name/set": { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "review/start": { params: ReviewStartParams; result: ReviewStartResponse };
  "turn/start": { params: TurnStartParams; result: TurnStartResponse };
  "turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export type AppServerMethod = keyof AppServerMethodMap;
export type AppServerRequestParams<M extends AppServerMethod> = AppServerMethodMap[M]["params"];
export type AppServerResponse<M extends AppServerMethod> = AppServerMethodMap[M]["result"];
export type AppServerNotification = ServerNotification;
export type AppServerNotificationHandler = (message: AppServerNotification) => void;
