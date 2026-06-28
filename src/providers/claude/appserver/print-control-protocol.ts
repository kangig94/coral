import { isRecord } from '../../../infra/json.js';

export const claudeControlRequestSubtypes = {
  initialize: 'initialize',
  interrupt: 'interrupt',
  canUseTool: 'can_use_tool',
  setModel: 'set_model',
  setMaxThinkingTokens: 'set_max_thinking_tokens',
} as const;

export type SDKControlInitializeRequest = {
  subtype: typeof claudeControlRequestSubtypes.initialize;
  systemPrompt?: string;
  [key: string]: unknown;
};

export type SDKControlInterruptRequest = {
  subtype: typeof claudeControlRequestSubtypes.interrupt;
  [key: string]: unknown;
};

export type SDKControlSetModelRequest = {
  subtype: typeof claudeControlRequestSubtypes.setModel;
  model?: string;
  [key: string]: unknown;
};

export type SDKControlSetMaxThinkingTokensRequest = {
  subtype: typeof claudeControlRequestSubtypes.setMaxThinkingTokens;
  max_thinking_tokens: number | null;
  [key: string]: unknown;
};

export type SDKControlRequest =
  | SDKControlInitializeRequest
  | SDKControlInterruptRequest
  | SDKControlSetModelRequest
  | SDKControlSetMaxThinkingTokensRequest;

export type SDKControlResponse = {
  type: 'control_response';
  response: {
    subtype: 'success' | 'error';
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
    [key: string]: unknown;
  };
};

export type SDKPermissionRequestMessage = {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: typeof claudeControlRequestSubtypes.canUseTool;
    tool_name: string;
    input: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export type SDKAssistantMessage = {
  type: 'assistant';
  message: {
    content?: unknown;
    model?: string;
    [key: string]: unknown;
  };
  session_id?: string;
  sessionId?: string;
  [key: string]: unknown;
};

export type SDKSystemMessage = {
  type: 'system';
  subtype?: string;
  session_id?: string;
  sessionId?: string;
  model?: string;
  [key: string]: unknown;
};

export type SDKResultMessage = {
  type: 'result';
  subtype?: string | null;
  result?: string;
  session_id?: string;
  sessionId?: string;
  model?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: unknown;
  is_error?: boolean;
  errors?: unknown;
  [key: string]: unknown;
};

export type SDKKeepAliveMessage = {
  type: 'keep_alive';
  [key: string]: unknown;
};

export type ClaudePrintStdoutMessage =
  | SDKAssistantMessage
  | SDKSystemMessage
  | SDKResultMessage
  | SDKPermissionRequestMessage
  | SDKControlResponse
  | SDKKeepAliveMessage;

const jsLineTerminators = /\u2028|\u2029/g;

export function ndjsonSafeStringify(message: unknown): string {
  const json = JSON.stringify(message);
  if (json === undefined) {
    throw new TypeError('NDJSON messages must be JSON-serializable.');
  }

  return `${json.replace(jsLineTerminators, (char) => (char === '\u2028' ? '\\u2028' : '\\u2029'))}\n`;
}

export function parseClaudePrintStdoutLine(line: string): ClaudePrintStdoutMessage | null {
  const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (normalizedLine.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedLine);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }

  switch (parsed.type) {
    case 'assistant':
      return parseAssistantMessage(parsed);
    case 'system':
      return parsed as SDKSystemMessage;
    case 'result':
      return parsed as SDKResultMessage;
    case 'control_request':
      return parsePermissionRequest(parsed);
    case 'control_response':
      return parseControlResponse(parsed);
    case 'keep_alive':
      return parsed as SDKKeepAliveMessage;
    default:
      return null;
  }
}

function parseAssistantMessage(value: Record<string, unknown>): SDKAssistantMessage | null {
  return isRecord(value.message) ? (value as SDKAssistantMessage) : null;
}

function parsePermissionRequest(value: Record<string, unknown>): SDKPermissionRequestMessage | null {
  if (typeof value.request_id !== 'string' || !isRecord(value.request)) {
    return null;
  }
  if (value.request.subtype !== claudeControlRequestSubtypes.canUseTool) {
    return null;
  }
  if (typeof value.request.tool_name !== 'string' || !isRecord(value.request.input)) {
    return null;
  }
  return value as SDKPermissionRequestMessage;
}

function parseControlResponse(value: Record<string, unknown>): SDKControlResponse | null {
  if (!isRecord(value.response)) {
    return null;
  }
  const { subtype, request_id: requestId } = value.response;
  if ((subtype !== 'success' && subtype !== 'error') || typeof requestId !== 'string') {
    return null;
  }
  return value as SDKControlResponse;
}
