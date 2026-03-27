#!/usr/bin/env node

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
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readStdin, sweepStale } from './lib/hook-utils.mjs';

const DEFAULT_STATE = {
  prompt: '',
  iteration: 1,
  maxIterations: 0,
  completionPromise: 'TASK COMPLETE',
};

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const sessionId = input.session_id || input.sessionId;
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || '.');

  if (event === 'UserPromptSubmit') {
    if (!sessionId) process.exit(0);
    const message = input.user_message || input.message || input.prompt || '';
    if (!/\/(?:coral:)?ralph\b/.test(message)) process.exit(0);
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
    if (!/coral:ralph|^ralph$/.test(skill)) process.exit(0);
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
    deleteFile(statePath);
    sweepStale(stateDir, 'ralph-state-', 24 * 60 * 60_000);
    process.exit(0);
  }

  if (state.completionPromise) {
    const promiseText = extractPromiseText(
      extractAssistantText(input.last_assistant_message)
      || readLastAssistantText(input.transcript_path)
    );

    if (promiseText && normalizeWhitespace(promiseText) === normalizeWhitespace(state.completionPromise)) {
      deleteFile(statePath);
      sweepStale(stateDir, 'ralph-state-', 24 * 60 * 60_000);
      process.exit(0);
    }
  }

  const nextState = {
    ...state,
    iteration: state.iteration + 1,
  };
  atomicWriteJson(statePath, nextState);
  const ctxPct = readCtxPct(sessionId);
  let ctxNote = '';
  if (ctxPct != null) {
    const compactPct = parseInt(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, 10) || 95;
    if (ctxPct >= compactPct - 10) {
      ctxNote = `\n\nContext usage is at ${ctxPct}%. Continue working — auto-compact will trigger automatically.`;
    } else {
      ctxNote = `\n\nContext usage is currently ${ctxPct}%. Do NOT stop due to context concerns.`;
    }
  } else {
    ctxNote = '\n\nDo NOT stop due to context concerns — auto-compact handles context management automatically.';
  }
  writeJson({
    decision: 'block',
    reason: `${state.prompt}\n\nIf already complete, output <promise>${state.completionPromise}</promise> immediately. If not complete, continue from where you left off.${ctxNote}`,
    systemMessage: `🔄 Ralph iteration ${nextState.iteration}`,
  });
} catch {
  process.exit(0);
}

function readCtxPct(sessionId) {
  try {
    const sessionsPath = join(homedir(), '.claude', 'hud', '.coral-sessions.json');
    const all = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    const entry = all[sessionId];
    if (!entry || entry.ctx == null) return null;
    if (Date.now() - (entry.ts || 0) > 5 * 60 * 1000) return null;
    return entry.ctx;
  } catch {
    return null;
  }
}

function createStateFile(projectDir, sessionId) {
  const statePath = getStatePath(projectDir, sessionId);
  atomicWriteJson(statePath, DEFAULT_STATE);
  return statePath;
}

function getStatePath(projectDir, sessionId) {
  const projectSlug = projectDir.replace(/\//g, '-');
  return join(tmpdir(), 'coral', projectSlug, `ralph-state-${sessionId}.json`);
}

function buildAdditionalContext(statePath) {
  return `Ralph loop state file created: ${statePath}. In SKILL.md step 1: if plan mode, delete this file. If prompt mode, write your cleaned prompt (flags stripped) to the 'prompt' field, optionally override maxIterations and completionPromise.`;
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

function extractPromiseText(text) {
  if (!text) return '';
  const match = text.match(/<promise>([\s\S]*?)<\/promise>/);
  return match?.[1]?.trim() || '';
}

function normalizeWhitespace(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function writeJson(value) {
  console.log(JSON.stringify(value));
}

