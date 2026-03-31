import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.js";
import { ensureBrokerSession } from "./broker-lifecycle.js";
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerNotificationHandler,
  AppServerRequestParams,
  AppServerResponse,
  ClientInfo,
  CodexAppServerClientOptions,
  InitializeCapabilities
} from "./app-server-protocol.js";

type ProtocolError = Error & { data?: unknown; rpcCode?: number };

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const DEFAULT_CLIENT_INFO: ClientInfo = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code: number, message: string, data?: unknown): { code: number; message: string; data?: unknown } {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message: string, data?: unknown): ProtocolError {
  const error = new Error(message) as ProtocolError;
  error.data = data;
  if ((data as { code?: number })?.code !== undefined) {
    error.rpcCode = (data as { code: number }).code;
  }
  return error;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method: string;
}

class AppServerClientBase {
  cwd: string;
  options: CodexAppServerClientOptions;
  pending: Map<number, PendingRequest>;
  nextId: number;
  stderr: string;
  closed: boolean;
  exitError: Error | null;
  notificationHandler: AppServerNotificationHandler | null;
  lineBuffer: string;
  transport: string;
  exitPromise: Promise<void>;
  resolveExit!: (value: undefined) => void;
  exitResolved?: boolean;

  constructor(cwd: string, options: CodexAppServerClientOptions = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler: AppServerNotificationHandler | null): void {
    this.notificationHandler = handler;
  }

  request<M extends AppServerMethod>(method: M, params: AppServerRequestParams<M>): Promise<AppServerResponse<M>> {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk: string): void {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: { id?: number; method?: string; error?: { message?: string }; result?: unknown; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${(error as Error).message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message as { id: number; method: string });
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message as AppServerNotification);
    }
  }

  handleServerRequest(message: { id: number; method: string }): void {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error?: Error | null): void {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message: unknown): void {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  proc?: ChildProcess;
  readline?: readline.Interface;

  constructor(cwd: string, options: CodexAppServerClientOptions = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize(): Promise<void> {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.proc.stdout!.setEncoding("utf8");
    this.proc.stderr!.setEncoding("utf8");

    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error: Error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code: number | null, signal: string | null) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(`codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout! });
    this.readline.on("line", (line: string) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin!.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGTERM");
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  endpoint?: string;
  socket?: net.Socket;

  constructor(cwd: string, options: CodexAppServerClientOptions & { brokerEndpoint?: string } = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint!);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", () => resolve());
      this.socket.on("data", (chunk: string) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error: Error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd: string, options: CodexAppServerClientOptions = {}): Promise<AppServerClientBase> {
    let brokerEndpoint: string | null = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
