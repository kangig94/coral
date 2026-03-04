import { isRecord } from '../../shared/mcp-utils.js';
import type { ClaudeJsonOutput } from './types.js';

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
  if (lines.length > 1) {
    return parseNdjson(lines);
  }

  if (lines.length === 1) {
    try {
      const parsed = JSON.parse(lines[0]);
      // Old legacy format: result field is an object (content array or response field).
      // Stream-json result events carry result as a string or null.
      if (isRecord(parsed) && isRecord((parsed as Record<string, unknown>).result)) {
        const legacy = parsed as ClaudeJsonOutput;
        return {
          response: extractLegacyResponse(legacy),
          sessionId: typeof legacy.session_id === 'string' ? legacy.session_id : null,
          model: typeof legacy.model === 'string' ? legacy.model : null,
          costUsd: typeof legacy.total_cost_usd === 'number' ? legacy.total_cost_usd : 0,
          durationMs: null,
          numTurns: null,
          isError: false,
        };
      }
      // Stream-json single-event (system, result with string, etc.) → NDJSON path
      return parseNdjson(lines);
    } catch {
      return PARSE_FAILURE_SENTINEL;
    }
  }

  return PARSE_FAILURE_SENTINEL;
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
  const textParts: string[] = [];

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
      for (const block of content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
    }
  }

  if (!hasValidLine) return PARSE_FAILURE_SENTINEL;
  if (!response && textParts.length > 0) response = textParts.join('');

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

function extractLegacyResponse(parsed: ClaudeJsonOutput): string {
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
