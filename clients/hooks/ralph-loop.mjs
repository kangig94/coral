#!/usr/bin/env node
//
// ralph-loop — multi-event hook driving the `/coral:ralph` iteration loop.
//
//   UserPromptSubmit  : on `/coral:ralph ...`, create state file + inject
//                       a SKILL.md hand-off pointing at it.
//   PreToolUse(Skill) : same for Claude-initiated Skill("coral:ralph").
//   Stop              : end the loop (promise matched, abort sentinel,
//                       maxIterations cap) or `decision: 'block'` to drive
//                       the next iteration.

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { claudeConfigDir, exitIfChildProcess, exitIfWrongFlavor, readStdin, readUserMessage, sweepStale } from './lib/hook-utils.mjs';
import { projectDirFromInput, projectTmpDir } from './lib/plugin-paths.mjs';
import { RALPH_FIELD_RE, RALPH_MESSAGE_RE } from './lib/coral-skills.mjs';
import { hasLiveWork } from './lib/live-work-registry.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

const DEFAULT_STATE = {
  prompt: '',
  iteration: 1,
  maxIterations: 0,
  completionPromise: 'TASK COMPLETE',
};

const ABORT_SENTINEL = 'STOP_LOOP';
const STATE_FILE_PREFIX = 'ralph-state-';
const STATE_SWEEP_TTL_MS = 24 * 60 * 60_000;
const PROMISE_TAG_RE = /<promise>([\s\S]*?)<\/promise>/;
const ABORT_TAG_RE = /<abort>([\s\S]*?)<\/abort>/;

// === Main I/O ===

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const sessionId = input.session_id || input.sessionId;
  const projectDir = resolve(projectDirFromInput(input));

  if (event === 'UserPromptSubmit') {
    if (!sessionId) process.exit(0);
    if (!RALPH_MESSAGE_RE.test(readUserMessage(input))) process.exit(0);
    const statePath = createStateFile(projectDir, sessionId);
    writeJson({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: buildAdditionalContext(statePath),
      },
    });
    process.exit(0);
  }

  if (event === 'PreToolUse') {
    if (!sessionId) process.exit(0);
    const skill = input.tool_input?.skill || '';
    if (!RALPH_FIELD_RE.test(skill)) process.exit(0);
    const statePath = createStateFile(projectDir, sessionId);
    writeJson({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: buildAdditionalContext(statePath),
      },
    });
    process.exit(0);
  }

  if (event !== 'Stop') process.exit(0);
  if (input.stop_reason === 'context_limit' || input.stopReason === 'context_limit' || input.user_requested === true) {
    process.exit(0);
  }
  if (!sessionId) process.exit(0);

  const statePath = getStatePath(projectDir, sessionId);
  if (!existsSync(statePath)) process.exit(0);

  const state = readState(statePath);
  if (!state || !state.prompt) process.exit(0);

  const stateDir = dirname(statePath);

  if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
    endLoop(statePath, stateDir);
  }

  const assistantText = extractAssistantText(input.last_assistant_message)
    || readLastAssistantText(input.transcript_path);

  const abortText = extractAbortText(assistantText);
  if (abortText && normalizeWhitespace(abortText) === ABORT_SENTINEL) {
    endLoop(statePath, stateDir);
  }

  if (state.completionPromise) {
    const promiseText = extractPromiseText(assistantText);
    if (promiseText && normalizeWhitespace(promiseText) === normalizeWhitespace(state.completionPromise)) {
      endLoop(statePath, stateDir);
    }
  }

  // Defer the next iteration while any background work (subagent or backgrounded
  // Bash/Monitor) is still running; the loop resumes when its completion wakes the
  // session and this Stop reruns.
  if (hasLiveWork(projectDir, sessionId, input.transcript_path)) process.exit(0);

  const nextState = { ...state, iteration: state.iteration + 1 };
  atomicWriteJson(statePath, nextState);

  writeJson({
    decision: 'block',
    reason: buildBlockReason(state, sessionId),
    systemMessage: `🔄 Ralph iteration ${nextState.iteration}`,
  });
} catch {
  process.exit(0);
}

// === State file management ===

function getStatePath(projectDir, sessionId) {
  return join(projectTmpDir(projectDir), `${STATE_FILE_PREFIX}${sessionId}.json`);
}

function createStateFile(projectDir, sessionId) {
  const statePath = getStatePath(projectDir, sessionId);
  atomicWriteJson(statePath, DEFAULT_STATE);
  return statePath;
}

function readState(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  return {
    prompt: typeof state?.prompt === 'string' ? state.prompt : '',
    iteration: Number.isInteger(state?.iteration) ? state.iteration : DEFAULT_STATE.iteration,
    maxIterations: Number.isInteger(state?.maxIterations) ? state.maxIterations : DEFAULT_STATE.maxIterations,
    completionPromise: typeof state?.completionPromise === 'string'
      ? state.completionPromise
      : DEFAULT_STATE.completionPromise,
  };
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(value), 'utf8');
  renameSync(tempPath, path);
}

function deleteFile(path) {
  try {
    unlinkSync(path);
  } catch {}
}

function endLoop(statePath, stateDir) {
  deleteFile(statePath);
  sweepStale(stateDir, STATE_FILE_PREFIX, STATE_SWEEP_TTL_MS);
  process.exit(0);
}

// === Prompt injection ===

function buildAdditionalContext(statePath) {
  return `Ralph loop state file created: ${statePath}. Read this file first, then edit it. In SKILL.md step 1: if plan mode, delete this file. If prompt mode, write your cleaned prompt (flags stripped) to the 'prompt' field, optionally override maxIterations and completionPromise.`;
}

function buildBlockReason(state, sessionId) {
  const ctxNote = buildCtxNote(sessionId);
  return `${state.prompt}\n\n`
    + `If already complete, output <promise>${state.completionPromise}</promise> immediately.\n\n`
    + `If the loop must end without completion (unrecoverable error, blocking question for the user, requirements fundamentally unclear), write the reason in your reply body and output <abort>${ABORT_SENTINEL}</abort> on a separate line to terminate.\n\n`
    + `Otherwise, continue from where you left off.${ctxNote}`;
}

function buildCtxNote(sessionId) {
  const ctxPct = readCtxPct(sessionId);
  if (ctxPct == null) {
    return '\n\nDo NOT stop due to context concerns — auto-compact handles context management automatically.';
  }
  const compactPct = parseInt(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, 10) || 95;
  if (ctxPct >= compactPct - 10) {
    return `\n\nContext usage is at ${ctxPct}%. Continue working — auto-compact will trigger automatically.`;
  }
  return `\n\nContext usage is currently ${ctxPct}%. Do NOT stop due to context concerns.`;
}

function readCtxPct(sessionId) {
  try {
    const sessionsPath = join(claudeConfigDir(), 'hud', '.coral-sessions.json');
    const all = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const entry = all[sessionId];
    if (!entry || entry.ctx == null) return null;
    if (Date.now() - (entry.ts || 0) > 5 * 60 * 1000) return null;
    return entry.ctx;
  } catch {
    return null;
  }
}

// === Assistant-text extraction (transcript + tag parsing) ===

function extractAssistantText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractAssistantText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';

  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        return extractAssistantText(block);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value.message) return extractAssistantText(value.message);

  return '';
}

function readLastAssistantText(transcriptPath) {
  const lines = readTranscriptTail(transcriptPath);
  if (!lines) return '';

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const message = entry?.message;
      if (message?.role !== 'assistant' && entry?.type !== 'assistant') continue;
      const text = extractAssistantText(message || entry);
      if (text) return text;
    } catch {}
  }

  return '';
}

function readTranscriptTail(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const { size } = fstatSync(fd);
    const readSize = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, size - readSize);
    const lines = buffer.toString('utf8').split('\n');
    if (size > readSize) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function extractPromiseText(text) {
  return text ? (text.match(PROMISE_TAG_RE)?.[1]?.trim() || '') : '';
}

function extractAbortText(text) {
  return text ? (text.match(ABORT_TAG_RE)?.[1]?.trim() || '') : '';
}

function normalizeWhitespace(text) {
  return text.trim().replace(/\s+/g, ' ');
}

// === JSON output ===

function writeJson(value) {
  console.log(JSON.stringify(value));
}
