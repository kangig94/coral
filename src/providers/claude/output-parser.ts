import { isRecord } from '../../infra/json.js';
import type { ClaudeJsonOutput } from './exec-types.js';

export interface ParsedClaudeStreamOutput {
  response: string;
  sessionId: string | null;
  model: string | null;
  costUsd: number;
  durationMs: number | null;
  numTurns: number | null;
  isError: boolean;
}

const PARSE_FAILURE_SENTINEL: ParsedClaudeStreamOutput = {
  response: '',
  sessionId: null,
  model: null,
  costUsd: 0,
  durationMs: null,
  numTurns: null,
  isError: true,
};

export function parseClaudeStreamJson(output: string): ParsedClaudeStreamOutput {
  const lines = output.split('\n').filter(Boolean);
  if (lines.length === 0) return PARSE_FAILURE_SENTINEL;
  if (lines.length > 1) return parseNdjson(lines);

  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    return PARSE_FAILURE_SENTINEL;
  }

  // Single-result JSON carries result as an object; stream-json result events carry a string or null.
  if (isSingleResultJson(parsed)) return toSingleResultParsedOutput(parsed);
  // Stream-json single-event (system, result with string, etc.) → NDJSON path
  return parseNdjson(lines);
}

function parseNdjson(lines: string[]): ParsedClaudeStreamOutput {
  let response = '';
  let sessionId: string | null = null;
  let model: string | null = null;
  let costUsd = 0;
  let durationMs: number | null = null;
  let numTurns: number | null = null;
  let isError = false;
  let hasValidLine = false;
  const assistantMessages: string[] = [];

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === 'result' || event.type === 'assistant') hasValidLine = true;

    if (event.type === 'result') {
      if (typeof event.session_id === 'string') sessionId = event.session_id;
      if (typeof event.total_cost_usd === 'number') costUsd = event.total_cost_usd;
      if (typeof event.duration_ms === 'number') durationMs = event.duration_ms;
      if (typeof event.num_turns === 'number') numTurns = event.num_turns;
      if (typeof event.is_error === 'boolean') isError = event.is_error;
      if (typeof event.model === 'string' && !model) model = event.model;
      if (typeof event.result === 'string') response = event.result;
      continue;
    }

    if (event.type === 'assistant' && isRecord(event.message)) {
      if (typeof event.message.model === 'string' && !model) model = event.message.model;
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      const parts: string[] = [];
      for (const block of content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) assistantMessages.push(parts.join(''));
    }
  }

  if (!hasValidLine) return PARSE_FAILURE_SENTINEL;
  if (!response && assistantMessages.length > 0) response = assistantMessages.join('');

  // If the result event only captured trailing Insight block(s), walk backwards
  // through assistant messages until we find a non-Insight message, then concat forward.
  if (response && response.trimStart().startsWith('`★ Insight') && assistantMessages.length >= 2) {
    let i = assistantMessages.length - 2;
    while (i > 0 && assistantMessages[i].trimStart().startsWith('`★ Insight')) i--;
    response = assistantMessages.slice(i, -1).join('\n\n') + '\n\n' + response;
  }

  return {
    response,
    sessionId,
    model,
    costUsd,
    durationMs,
    numTurns,
    isError,
  };
}

function isSingleResultJson(parsed: unknown): parsed is ClaudeJsonOutput {
  return isRecord(parsed) && isRecord(parsed.result);
}

function toSingleResultParsedOutput(result: ClaudeJsonOutput): ParsedClaudeStreamOutput {
  return {
    response: extractSingleResultResponse(result),
    sessionId: typeof result.session_id === 'string' ? result.session_id : null,
    model: typeof result.model === 'string' ? result.model : null,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0,
    durationMs: null,
    numTurns: null,
    isError: false,
  };
}

function extractSingleResultResponse(parsed: ClaudeJsonOutput): string {
  if (typeof parsed.result === 'string') return parsed.result;
  if (isRecord(parsed.result)) {
    if (typeof parsed.result.response === 'string') return parsed.result.response;
    if (typeof parsed.result.output_text === 'string') return parsed.result.output_text;
    if (Array.isArray(parsed.result.content)) {
      const textParts = parsed.result.content
        .map((item: unknown) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean);
      if (textParts.length > 0) return textParts.join('\n');
    }
  }
  return '';
}
