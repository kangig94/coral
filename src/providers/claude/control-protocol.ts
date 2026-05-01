import { z } from 'zod';
import { isRecord } from '../../infra/json.js';

export const claudeControlRequestSubtypes = {
  initialize: 'initialize',
  interrupt: 'interrupt',
  canUseTool: 'can_use_tool',
  setModel: 'set_model',
  setMaxThinkingTokens: 'set_max_thinking_tokens',
} as const;

export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

const apiKeySourceSchema = z.enum(['user', 'project', 'org', 'temporary', 'oauth']);

const assistantMessageErrorSchema = z.enum([
  'authentication_failed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
  'unknown',
  'max_output_tokens',
]);

const statusSchema = z.union([z.literal('compacting'), z.null()]);

const unknownRecordSchema = z.record(z.string(), z.unknown());

const permissionRuleValueSchema = z
  .object({
    toolName: z.string(),
    ruleContent: z.string().optional(),
  })
  .passthrough();

const permissionUpdateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('addRules'),
    rules: z.array(permissionRuleValueSchema),
    behavior: z.enum(['allow', 'deny', 'ask']),
    destination: z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
  }),
  z.object({
    type: z.literal('replaceRules'),
    rules: z.array(permissionRuleValueSchema),
    behavior: z.enum(['allow', 'deny', 'ask']),
    destination: z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
  }),
  z.object({
    type: z.literal('removeRules'),
    rules: z.array(permissionRuleValueSchema),
    behavior: z.enum(['allow', 'deny', 'ask']),
    destination: z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
  }),
  z.object({
    type: z.literal('setMode'),
    mode: permissionModeSchema,
    destination: z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
  }),
  z.object({
    type: z.literal('addDirectories'),
    directories: z.array(z.string()),
    destination: z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
  }),
  z.object({
    type: z.literal('removeDirectories'),
    directories: z.array(z.string()),
    destination: z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
  }),
]);

const hookCallbackMatcherSchema = z
  .object({
    matcher: z.string().optional(),
    hookCallbackIds: z.array(z.string()),
    timeout: z.number().optional(),
  })
  .passthrough();

export const sdkControlInitializeRequestSchema = z
  .object({
    subtype: z.literal(claudeControlRequestSubtypes.initialize),
    hooks: z.record(z.string(), z.array(hookCallbackMatcherSchema)).optional(),
    sdkMcpServers: z.array(z.string()).optional(),
    jsonSchema: unknownRecordSchema.optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    agents: unknownRecordSchema.optional(),
    promptSuggestions: z.boolean().optional(),
    agentProgressSummaries: z.boolean().optional(),
  })
  .passthrough();

export const sdkControlInterruptRequestSchema = z
  .object({
    subtype: z.literal(claudeControlRequestSubtypes.interrupt),
  })
  .passthrough();

export const sdkControlPermissionRequestSchema = z
  .object({
    subtype: z.literal(claudeControlRequestSubtypes.canUseTool),
    tool_name: z.string(),
    input: unknownRecordSchema,
    permission_suggestions: z.array(permissionUpdateSchema).optional(),
    blocked_path: z.string().optional(),
    decision_reason: z.string().optional(),
    title: z.string().optional(),
    display_name: z.string().optional(),
    tool_use_id: z.string(),
    agent_id: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export const sdkControlSetModelRequestSchema = z
  .object({
    subtype: z.literal(claudeControlRequestSubtypes.setModel),
    model: z.string().optional(),
  })
  .passthrough();

export const sdkControlSetMaxThinkingTokensRequestSchema = z
  .object({
    subtype: z.literal(claudeControlRequestSubtypes.setMaxThinkingTokens),
    max_thinking_tokens: z.number().nullable(),
  })
  .passthrough();

const sdkControlRequestInnerSchema = z.discriminatedUnion('subtype', [
  sdkControlInitializeRequestSchema,
  sdkControlInterruptRequestSchema,
  sdkControlPermissionRequestSchema,
  sdkControlSetModelRequestSchema,
  sdkControlSetMaxThinkingTokensRequestSchema,
]);

export const sdkControlRequestSchema = z
  .object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: sdkControlRequestInnerSchema,
  })
  .passthrough();

export const sdkControlSuccessResponseSchema = z
  .object({
    subtype: z.literal('success'),
    request_id: z.string(),
    response: unknownRecordSchema.optional(),
  })
  .passthrough();

export const sdkControlErrorResponseSchema = z
  .object({
    subtype: z.literal('error'),
    request_id: z.string(),
    error: z.string(),
    pending_permission_requests: z
      .array(
        z
          .object({
            type: z.literal('control_request'),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const sdkControlResponseInnerSchema = z.discriminatedUnion('subtype', [
  sdkControlSuccessResponseSchema,
  sdkControlErrorResponseSchema,
]);

export const sdkControlResponseSchema = z
  .object({
    type: z.literal('control_response'),
    response: sdkControlResponseInnerSchema,
  })
  .passthrough();

export const sdkKeepAliveSchema = z
  .object({
    type: z.literal('keep_alive'),
  })
  .passthrough();

const assistantContentTextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const assistantContentToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string(),
    input: unknownRecordSchema,
  })
  .passthrough();

const assistantContentUnknownBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const assistantContentBlockSchema = z.union([
  assistantContentTextBlockSchema,
  assistantContentToolUseBlockSchema,
  assistantContentUnknownBlockSchema,
]);

const sdkAssistantPayloadSchema = z
  .object({
    role: z.literal('assistant').optional(),
    content: z.array(assistantContentBlockSchema),
    model: z.string().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

export const sdkAssistantMessageSchema = z
  .object({
    type: z.literal('assistant'),
    message: sdkAssistantPayloadSchema,
    parent_tool_use_id: z.string().nullable(),
    error: assistantMessageErrorSchema.optional(),
    uuid: z.string(),
    session_id: z.string(),
  })
  .passthrough();

const modelUsageSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    webSearchRequests: z.number(),
    costUSD: z.number(),
    contextWindow: z.number(),
    maxOutputTokens: z.number(),
  })
  .passthrough();

const permissionDenialSchema = z
  .object({
    tool_name: z.string(),
    tool_use_id: z.string(),
    tool_input: unknownRecordSchema,
  })
  .passthrough();

const resultBaseShape = {
  type: z.literal('result'),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  is_error: z.boolean(),
  num_turns: z.number(),
  stop_reason: z.string().nullable(),
  total_cost_usd: z.number(),
  usage: z.unknown(),
  modelUsage: z.record(z.string(), modelUsageSchema),
  permission_denials: z.array(permissionDenialSchema),
  fast_mode_state: z.unknown().optional(),
  uuid: z.string(),
  session_id: z.string(),
};

const sdkResultSuccessMessageSchema = z
  .object({
    ...resultBaseShape,
    subtype: z.literal('success'),
    result: z.string(),
    structured_output: z.unknown().optional(),
  })
  .passthrough();

const sdkResultErrorMessageSchema = z
  .object({
    ...resultBaseShape,
    subtype: z.enum([
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]),
    errors: z.array(z.string()),
  })
  .passthrough();

export const sdkResultMessageSchema = z.union([sdkResultSuccessMessageSchema, sdkResultErrorMessageSchema]);

const systemBaseShape = {
  type: z.literal('system'),
  uuid: z.string(),
  session_id: z.string(),
};

const sdkSystemInitMessageSchema = z
  .object({
    ...systemBaseShape,
    subtype: z.literal('init'),
    agents: z.array(z.string()).optional(),
    apiKeySource: apiKeySourceSchema,
    betas: z.array(z.string()).optional(),
    claude_code_version: z.string(),
    cwd: z.string(),
    tools: z.array(z.string()),
    mcp_servers: z.array(
      z
        .object({
          name: z.string(),
          status: z.string(),
        })
        .passthrough(),
    ),
    model: z.string(),
    permissionMode: permissionModeSchema,
    slash_commands: z.array(z.string()),
    output_style: z.string(),
    skills: z.array(z.string()),
    plugins: z.array(
      z
        .object({
          name: z.string(),
          path: z.string(),
          source: z.string().optional(),
        })
        .passthrough(),
    ),
    fast_mode_state: z.unknown().optional(),
  })
  .passthrough();

const sdkSystemStatusMessageSchema = z
  .object({
    ...systemBaseShape,
    subtype: z.literal('status'),
    status: statusSchema,
    permissionMode: permissionModeSchema.optional(),
  })
  .passthrough();

const sdkSystemApiRetryMessageSchema = z
  .object({
    ...systemBaseShape,
    subtype: z.literal('api_retry'),
    attempt: z.number(),
    max_retries: z.number(),
    retry_delay_ms: z.number(),
    error_status: z.number().nullable(),
    error: assistantMessageErrorSchema,
  })
  .passthrough();

const sdkSystemHookStartedMessageSchema = z
  .object({
    ...systemBaseShape,
    subtype: z.literal('hook_started'),
    hook_id: z.string(),
    hook_name: z.string(),
    hook_event: z.string(),
  })
  .passthrough();

const sdkSystemHookProgressMessageSchema = z
  .object({
    ...systemBaseShape,
    subtype: z.literal('hook_progress'),
    hook_id: z.string(),
    hook_name: z.string(),
    hook_event: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    output: z.string(),
  })
  .passthrough();

const sdkSystemHookResponseMessageSchema = z
  .object({
    ...systemBaseShape,
    subtype: z.literal('hook_response'),
    hook_id: z.string(),
    hook_name: z.string(),
    hook_event: z.string(),
    output: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number().optional(),
    outcome: z.enum(['success', 'error', 'cancelled']),
  })
  .passthrough();

const sdkSystemSessionStateChangedMessageSchema = z
  .object({
    ...systemBaseShape,
    subtype: z.literal('session_state_changed'),
    state: z.enum(['idle', 'running', 'requires_action']),
  })
  .passthrough();

export const sdkSystemMessageSchema = z.discriminatedUnion('subtype', [
  sdkSystemInitMessageSchema,
  sdkSystemStatusMessageSchema,
  sdkSystemApiRetryMessageSchema,
  sdkSystemHookStartedMessageSchema,
  sdkSystemHookProgressMessageSchema,
  sdkSystemHookResponseMessageSchema,
  sdkSystemSessionStateChangedMessageSchema,
]);

const sdkStdoutControlRequestSchema = z
  .object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: sdkControlPermissionRequestSchema,
  })
  .passthrough();

export const claudeStdoutMessageSchema = z.union([
  sdkAssistantMessageSchema,
  sdkResultMessageSchema,
  sdkSystemMessageSchema,
  sdkStdoutControlRequestSchema,
  sdkControlResponseSchema,
  sdkKeepAliveSchema,
]);

export type SDKControlInitializeRequest = z.infer<typeof sdkControlInitializeRequestSchema>;
export type SDKControlInterruptRequest = z.infer<typeof sdkControlInterruptRequestSchema>;
export type SDKControlSetModelRequest = z.infer<typeof sdkControlSetModelRequestSchema>;
export type SDKControlSetMaxThinkingTokensRequest = z.infer<typeof sdkControlSetMaxThinkingTokensRequestSchema>;
export type SDKControlRequest = z.infer<typeof sdkControlRequestSchema>;
export type SDKControlResponse = z.infer<typeof sdkControlResponseSchema>;
export type SDKKeepAlive = z.infer<typeof sdkKeepAliveSchema>;
export type SDKAssistantMessage = z.infer<typeof sdkAssistantMessageSchema>;
export type SDKResultMessage = z.infer<typeof sdkResultMessageSchema>;
export type SDKSystemMessage = z.infer<typeof sdkSystemMessageSchema>;
export type SDKPermissionRequestMessage = z.infer<typeof sdkStdoutControlRequestSchema>;
export type ClaudeStdoutMessage = z.infer<typeof claudeStdoutMessageSchema>;

const jsLineTerminators = /\u2028|\u2029/g;

function escapeJsLineTerminators(json: string): string {
  return json.replace(jsLineTerminators, (character) => (character === '\u2028' ? '\\u2028' : '\\u2029'));
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseWithSchema<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function matchesSchema<T extends z.ZodTypeAny>(schema: T, value: unknown): value is z.infer<T> {
  return schema.safeParse(value).success;
}

export function ndjsonSafeStringify(message: unknown): string {
  const json = JSON.stringify(message);
  if (json === undefined) {
    throw new TypeError('NDJSON messages must be JSON-serializable.');
  }

  return `${escapeJsLineTerminators(json)}\n`;
}

export function parseClaudeStdoutLine(line: string): ClaudeStdoutMessage | null {
  const normalizedLine = stripTrailingCarriageReturn(line);
  if (normalizedLine.trim().length === 0) return null;

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
      return parseWithSchema(sdkAssistantMessageSchema, parsed);
    case 'result':
      return parseWithSchema(sdkResultMessageSchema, parsed);
    case 'system':
      return parseWithSchema(sdkSystemMessageSchema, parsed);
    case 'control_request':
      return parseWithSchema(sdkStdoutControlRequestSchema, parsed);
    case 'control_response':
      return parseWithSchema(sdkControlResponseSchema, parsed);
    case 'keep_alive':
      return parseWithSchema(sdkKeepAliveSchema, parsed);
    default:
      return null;
  }
}

export function isAssistantMessage(message: unknown): message is SDKAssistantMessage {
  return matchesSchema(sdkAssistantMessageSchema, message);
}

export function isControlRequest(message: unknown): message is SDKControlRequest {
  return matchesSchema(sdkControlRequestSchema, message);
}

export function isPermissionRequest(message: unknown): message is SDKPermissionRequestMessage {
  return matchesSchema(sdkStdoutControlRequestSchema, message);
}

export function isControlResponse(message: unknown): message is SDKControlResponse {
  return matchesSchema(sdkControlResponseSchema, message);
}

export function isKeepAliveMessage(message: unknown): message is SDKKeepAlive {
  return matchesSchema(sdkKeepAliveSchema, message);
}

export function isResultMessage(message: unknown): message is SDKResultMessage {
  return matchesSchema(sdkResultMessageSchema, message);
}

export function isSystemMessage(message: unknown): message is SDKSystemMessage {
  return matchesSchema(sdkSystemMessageSchema, message);
}
