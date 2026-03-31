#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexLoginStatus } from "./lib/codex.js";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.js";
import { getConfig, listJobs } from "./lib/state.js";
import { sortJobsNewestFirst } from "./lib/job-control.js";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.js";
import { resolveWorkspaceRoot } from "./lib/workspace.js";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

interface HookInput {
  session_id?: string;
  cwd?: string;
  last_assistant_message?: string;
  [key: string]: unknown;
}

interface JobRecord {
  id: string;
  status: string;
  sessionId?: string;
  jobClass?: string;
  [key: string]: unknown;
}

function readHookInput(): HookInput {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as HookInput;
}

function emitDecision(payload: { decision: string; reason: string }): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message: string | null): void {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs: JobRecord[], input: HookInput = {}): JobRecord[] {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input: HookInput = {}): string {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd: string): string | null {
  const authStatus = getCodexLoginStatus(cwd);
  if (authStatus.available && authStatus.loggedIn) {
    return null;
  }

  const detail = authStatus.detail ? ` ${authStatus.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup and, if needed, !codex login.`;
}

function parseStopReviewOutput(rawOutput: string | null | undefined): { ok: boolean; reason: string | null } {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd: string, input: HookInput = {}): { ok: boolean; reason: string | null } {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out after 15 minutes. Run /codex:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout) as { rawOutput?: string };
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

function main(): void {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot) as { stopReviewGate?: boolean };

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot) as JobRecord[], input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : (review.reason ?? "")
    });
    return;
  }

  logNote(runningTaskNote);
}

main();
