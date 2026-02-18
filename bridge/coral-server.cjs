"use strict";

// src/mcp/server.ts
var import_server = require("@modelcontextprotocol/sdk/server/index.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");

// src/mcp/codex-executor.ts
var import_node_child_process2 = require("node:child_process");

// src/mcp/output-parser.ts
function parseCodexJsonl(output) {
  const lines = output.trim().split("\n").filter((l) => l.trim());
  const messages = [];
  const errors = [];
  const warnings = [];
  let threadId = null;
  const errorMessages = /* @__PURE__ */ new Set();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) {
        threadId = event.thread_id;
        continue;
      }
      if (event.type === "item.completed" && event.item) {
        if (event.item.type === "agent_message" && event.item.text) {
          messages.push(event.item.text);
        }
        if (event.item.type === "error" && event.item.message) {
          warnings.push(event.item.message);
        }
        continue;
      }
      if (event.type === "error" && event.message) {
        errorMessages.add(event.message);
        errors.push(event.message);
        continue;
      }
      if (event.type === "turn.failed" && event.error?.message) {
        if (!errorMessages.has(event.error.message)) {
          errors.push(event.error.message);
        }
        continue;
      }
    } catch {
    }
  }
  return {
    response: messages.join("\n"),
    threadId,
    errors,
    warnings
  };
}

// src/mcp/cli-detection.ts
var import_node_child_process = require("node:child_process");
var cached = null;
async function detectCodexCli() {
  if (cached) return cached;
  cached = await new Promise((resolve) => {
    (0, import_node_child_process.execFile)("codex", ["--version"], { timeout: 1e4 }, (err, stdout) => {
      if (err) {
        resolve({
          available: false,
          error: "Codex CLI not found. Install it with: npm install -g @openai/codex"
        });
      } else {
        const version = stdout.trim();
        resolve({ available: true, version, path: "codex" });
      }
    });
  });
  return cached;
}

// src/mcp/codex-executor.ts
var DEFAULT_TIMEOUT = 15 * 60 * 1e3;
var TIMEOUT_MS = parseInt(process.env.CORAL_CODEX_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT;
var DEFAULT_MODEL = process.env.CORAL_CODEX_MODEL ?? "gpt-5.3-codex";
var MAX_BUFFER = 10 * 1024 * 1024;
var SIGKILL_DELAY = 5e3;
var MAX_CONCURRENT = parseInt(process.env.CORAL_MAX_CONCURRENT ?? "", 10) || 5;
var STAGGER_MS = parseInt(process.env.CORAL_STAGGER_MS ?? "", 10) || 3e3;
var Semaphore = class {
  constructor(max) {
    this.max = max;
  }
  running = 0;
  queue = [];
  acquire() {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }
  release() {
    if (this.running <= 0) {
      throw new Error("Semaphore: release called without matching acquire");
    }
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
  /** Current number of running tasks. Exposed for testing. */
  get active() {
    return this.running;
  }
  /** Current number of waiting tasks. Exposed for testing. */
  get pending() {
    return this.queue.length;
  }
};
var semaphore = new Semaphore(MAX_CONCURRENT);
var lastStartTime = 0;
var shuttingDown = false;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var staggerMutex = new Semaphore(1);
async function enforceStagger() {
  await staggerMutex.acquire();
  try {
    const gap = Date.now() - lastStartTime;
    if (gap < STAGGER_MS) {
      await sleep(STAGGER_MS - gap);
    }
    lastStartTime = Date.now();
  } finally {
    staggerMutex.release();
  }
}
var activeChildren = /* @__PURE__ */ new Set();
function getModel(model) {
  return model?.trim() || DEFAULT_MODEL;
}
function appendBuffer(current, chunk) {
  const combined = current + chunk;
  if (combined.length > MAX_BUFFER) {
    return combined.slice(0, MAX_BUFFER) + "\n[output truncated at 10MB]";
  }
  return combined;
}
function spawnCodex(args, prompt, cwd) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = (0, import_node_child_process2.spawn)("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...cwd ? { cwd } : {},
      ...process.platform === "win32" ? { shell: true } : {}
    });
    activeChildren.add(child);
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, SIGKILL_DELAY);
      child.on("close", () => clearTimeout(killTimer));
      activeChildren.delete(child);
      reject(new Error(`Codex timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    function finish() {
      if (settled) return false;
      settled = true;
      clearTimeout(timeoutHandle);
      activeChildren.delete(child);
      return true;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout = appendBuffer(stdout, data.toString());
    });
    child.stderr.on("data", (data) => {
      stderr = appendBuffer(stderr, data.toString());
    });
    child.on("close", (code) => {
      if (finish()) resolve({ stdout, stderr, code });
    });
    child.on("error", (err) => {
      if (finish()) reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
    });
    if (prompt) {
      child.stdin.on("error", (err) => {
        if (finish()) {
          child.kill("SIGTERM");
          reject(new Error(`Stdin write error: ${err.message}`));
        }
      });
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}
function assertNotShuttingDown() {
  if (shuttingDown) throw new Error("Server is shutting down");
}
async function runCodex(args, prompt, cwd) {
  await semaphore.acquire();
  try {
    assertNotShuttingDown();
    await enforceStagger();
    assertNotShuttingDown();
    return await spawnCodex(args, prompt, cwd);
  } finally {
    semaphore.release();
  }
}
function killAllChildren() {
  shuttingDown = true;
  for (const child of activeChildren) {
    try {
      child.kill("SIGTERM");
    } catch {
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, 3e3);
    child.on("close", () => clearTimeout(killTimer));
  }
  activeChildren.clear();
}
async function executeOneShot(prompt, model, cwd) {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(cli.error);
  const resolvedModel = getModel(model);
  const args = ["exec", "-m", resolvedModel, "--json", "--full-auto"];
  const start = Date.now();
  const { stdout, stderr, code } = await runCodex(args, prompt, cwd);
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`Codex exited with code ${code}: ${stderr || "No output"}`);
  }
  const parsed = parseCodexJsonl(stdout);
  return {
    response: parsed.response,
    threadId: parsed.threadId,
    model: resolvedModel,
    durationMs: Date.now() - start,
    exitCode: code,
    errors: parsed.errors,
    warnings: parsed.warnings
  };
}
async function executeResume(threadId, prompt, model, cwd) {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(cli.error);
  const resolvedModel = getModel(model);
  const args = ["exec", "resume", threadId, "-m", resolvedModel, "--json", "--full-auto"];
  const start = Date.now();
  const { stdout, stderr, code } = await runCodex(args, prompt, cwd);
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`Codex resume exited with code ${code}: ${stderr || "No output"}`);
  }
  const parsed = parseCodexJsonl(stdout);
  return {
    response: parsed.response,
    threadId: parsed.threadId ?? threadId,
    model: resolvedModel,
    durationMs: Date.now() - start,
    exitCode: code,
    errors: parsed.errors,
    warnings: parsed.warnings
  };
}
async function executeFork(threadId, prompt, model, cwd) {
  const forkPrompt = prompt ?? "Continue from where we left off.";
  return executeResume(threadId, forkPrompt, model, cwd);
}

// src/mcp/session-manager.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var REGISTRY_DIR = (0, import_node_path.join)(".claude", "coral");
var REGISTRY_FILE = "sessions.json";
var SessionManager = class {
  registryPath;
  registry;
  constructor(workingDirectory) {
    const baseDir = workingDirectory ?? process.cwd();
    const dir = (0, import_node_path.join)(baseDir, REGISTRY_DIR);
    (0, import_node_fs.mkdirSync)(dir, { recursive: true });
    this.registryPath = (0, import_node_path.join)(dir, REGISTRY_FILE);
    this.registry = this.load();
  }
  load() {
    try {
      const data = (0, import_node_fs.readFileSync)(this.registryPath, "utf-8");
      return JSON.parse(data);
    } catch (err) {
      if (err instanceof SyntaxError) {
        process.stderr.write(`Warning: Corrupt session registry at ${this.registryPath}, starting fresh
`);
      } else if (err.code !== "ENOENT") {
        throw err;
      }
      return { version: 1, sessions: {} };
    }
  }
  save() {
    const tmpPath = this.registryPath + ".tmp";
    (0, import_node_fs.writeFileSync)(tmpPath, JSON.stringify(this.registry, null, 2), "utf-8");
    (0, import_node_fs.renameSync)(tmpPath, this.registryPath);
  }
  /** Register a new named session */
  register(name, codexThreadId, model, workingDirectory) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const entry = {
      name,
      codexThreadId,
      model,
      createdAt: now,
      lastUsedAt: now,
      workingDirectory
    };
    this.registry.sessions[name] = entry;
    this.save();
    return entry;
  }
  /** Look up by name or thread ID (name takes priority) */
  get(nameOrId) {
    if (this.registry.sessions[nameOrId]) {
      return this.registry.sessions[nameOrId];
    }
    for (const entry of Object.values(this.registry.sessions)) {
      if (entry.codexThreadId === nameOrId) {
        return entry;
      }
    }
    return null;
  }
  /** List all registered sessions */
  list() {
    return Object.values(this.registry.sessions);
  }
  /** Update session fields (lastUsedAt is always updated) */
  updateSession(name, fields) {
    const entry = this.registry.sessions[name];
    if (entry) {
      entry.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (fields?.model) {
        entry.model = fields.model;
      }
      this.save();
    }
  }
  /** Remove a session by name */
  remove(name) {
    if (this.registry.sessions[name]) {
      delete this.registry.sessions[name];
      this.save();
      return true;
    }
    return false;
  }
};

// src/mcp/schemas.ts
var import_zod = require("zod");
var modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
var modelSchema = import_zod.z.string().regex(modelPattern, "Model name must be alphanumeric with dots, hyphens, or underscores").optional();
var codexExecuteSchema = import_zod.z.object({
  prompt: import_zod.z.string().min(1, "Prompt is required"),
  model: modelSchema,
  working_directory: import_zod.z.string().optional(),
  save_session: import_zod.z.string().optional()
});
var codexSessionCreateSchema = import_zod.z.object({
  name: import_zod.z.string().min(1, "Session name is required"),
  prompt: import_zod.z.string().min(1, "Prompt is required"),
  model: modelSchema,
  working_directory: import_zod.z.string().optional()
});
var codexSessionSendSchema = import_zod.z.object({
  session: import_zod.z.string().min(1, "Session reference is required"),
  prompt: import_zod.z.string().min(1, "Prompt is required"),
  model: modelSchema,
  working_directory: import_zod.z.string().optional()
});
var codexSessionListSchema = import_zod.z.object({}).passthrough();
var codexSessionForkSchema = import_zod.z.object({
  session: import_zod.z.string().min(1, "Session reference is required"),
  name: import_zod.z.string().optional(),
  prompt: import_zod.z.string().optional(),
  model: modelSchema,
  working_directory: import_zod.z.string().optional()
});

// src/mcp/server.ts
var tools = [
  {
    name: "codex_execute",
    description: "Execute a one-shot prompt with OpenAI Codex CLI. Returns the Codex response, thread ID, model, duration, and any errors/warnings.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to send to Codex (required)" },
        model: { type: "string", description: "Codex model to use (default: gpt-5.3-codex)" },
        working_directory: { type: "string", description: "Working directory for Codex execution" },
        save_session: { type: "string", description: "If provided, save the session with this name to the registry" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "codex_session_create",
    description: "Create a new named Codex session. Executes the prompt and registers the session for later continuation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for this session (required)" },
        prompt: { type: "string", description: "Initial prompt to start the session (required)" },
        model: { type: "string", description: "Codex model to use (default: gpt-5.3-codex)" },
        working_directory: { type: "string", description: "Working directory for Codex execution" }
      },
      required: ["name", "prompt"]
    }
  },
  {
    name: "codex_session_send",
    description: "Send a follow-up prompt to an existing Codex session. Resumes the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name or Codex thread ID (required)" },
        prompt: { type: "string", description: "Follow-up prompt (required)" },
        model: { type: "string", description: "Codex model to use" },
        working_directory: { type: "string", description: "Working directory for Codex execution" }
      },
      required: ["session", "prompt"]
    }
  },
  {
    name: "codex_session_list",
    description: "List all Coral-registered Codex sessions.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "codex_session_fork",
    description: "Fork an existing Codex session. Resumes the session with an optional new prompt (note: uses resume-based simulation since codex fork is TUI-only).",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session name or thread ID to fork from (required)" },
        name: { type: "string", description: "Name for the new forked session" },
        prompt: { type: "string", description: "Optional prompt for the forked session" },
        model: { type: "string", description: "Codex model to use" },
        working_directory: { type: "string", description: "Working directory for Codex execution" }
      },
      required: ["session"]
    }
  }
];
function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}
function resultExtras(result) {
  return {
    ...result.exitCode !== 0 && result.exitCode !== null ? { exit_code: result.exitCode } : {},
    ...result.errors.length > 0 ? { errors: result.errors } : {},
    ...result.warnings.length > 0 ? { warnings: result.warnings } : {}
  };
}
async function handleCodexExecute(input, mgr) {
  const result = await executeOneShot(input.prompt, input.model, input.working_directory);
  if (input.save_session && result.threadId) {
    mgr.register(input.save_session, result.threadId, result.model, input.working_directory ?? process.cwd());
  }
  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        model: result.model,
        duration_ms: result.durationMs,
        ...input.save_session ? { saved_as: input.save_session } : {},
        ...resultExtras(result)
      },
      null,
      2
    )
  );
}
async function handleSessionCreate(input, mgr) {
  const result = await executeOneShot(input.prompt, input.model, input.working_directory);
  if (!result.threadId) {
    return textResult(
      JSON.stringify({
        response: result.response,
        notice: "No thread ID returned by Codex. Session not registered.",
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result)
      }, null, 2)
    );
  }
  mgr.register(input.name, result.threadId, result.model, input.working_directory ?? process.cwd());
  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        session_name: input.name,
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result)
      },
      null,
      2
    )
  );
}
async function handleSessionSend(input, mgr) {
  const entry = mgr.get(input.session);
  if (!entry) {
    const result2 = await executeResume(input.session, input.prompt, input.model, input.working_directory);
    return textResult(
      JSON.stringify(
        {
          response: result2.response,
          thread_id: result2.threadId,
          model: result2.model,
          duration_ms: result2.durationMs,
          ...result2.exitCode !== 0 && result2.exitCode !== null ? { exit_code: result2.exitCode } : {},
          ...result2.errors.length > 0 ? { errors: result2.errors } : {},
          ...result2.warnings.length > 0 ? { warnings: result2.warnings } : {}
        },
        null,
        2
      )
    );
  }
  const result = await executeResume(entry.codexThreadId, input.prompt, input.model, input.working_directory ?? entry.workingDirectory);
  mgr.updateSession(entry.name, input.model ? { model: input.model } : void 0);
  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        session_name: entry.name,
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result)
      },
      null,
      2
    )
  );
}
async function handleSessionList(mgr) {
  const registered = mgr.list().map((s) => ({
    name: s.name,
    thread_id: s.codexThreadId,
    model: s.model,
    created_at: s.createdAt,
    last_used_at: s.lastUsedAt,
    working_directory: s.workingDirectory
  }));
  return textResult(
    JSON.stringify(
      { sessions: registered, total: registered.length },
      null,
      2
    )
  );
}
async function handleSessionFork(input, mgr) {
  const entry = mgr.get(input.session);
  const sourceId = entry?.codexThreadId ?? input.session;
  const cwd = input.working_directory ?? entry?.workingDirectory;
  const result = await executeFork(sourceId, input.prompt, input.model, cwd);
  if (input.name && result.threadId) {
    mgr.register(input.name, result.threadId, result.model, cwd ?? process.cwd());
  }
  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        forked_from: sourceId,
        ...input.name ? { session_name: input.name } : {},
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result)
      },
      null,
      2
    )
  );
}
var server = new import_server.Server(
  { name: "coral", version: true ? "0.1.0" : "0.1.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(import_types.ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(import_types.CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const rawArgs = args ?? {};
  try {
    switch (name) {
      case "codex_execute":
        return await handleCodexExecute(codexExecuteSchema.parse(rawArgs), sessionManager);
      case "codex_session_create":
        return await handleSessionCreate(codexSessionCreateSchema.parse(rawArgs), sessionManager);
      case "codex_session_send":
        return await handleSessionSend(codexSessionSendSchema.parse(rawArgs), sessionManager);
      case "codex_session_list":
        codexSessionListSchema.parse(rawArgs);
        return await handleSessionList(sessionManager);
      case "codex_session_fork":
        return await handleSessionFork(codexSessionForkSchema.parse(rawArgs), sessionManager);
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}
`);
    return textResult(`Error: ${message}`, true);
  }
});
function shutdown() {
  process.stderr.write("Coral MCP Server shutting down...\n");
  killAllChildren();
  server.close().finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
var sessionManager;
async function main() {
  sessionManager = new SessionManager();
  const transport = new import_stdio.StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Coral MCP Server running on stdio\n");
}
main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}
`);
  process.exit(1);
});
