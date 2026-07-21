import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'Path must not contain NUL')
  .describe('reject-nul-in-provider-credential-path')
  .refine((value) => isAbsolute(value), 'Path must be absolute')
  .describe('require-absolute-provider-credential-path')
  .transform((value) => normalize(value))
  .describe('normalize-provider-credential-path');

const codexCredentialSourceSchema = z
  .object({ version: z.literal(1), provider: z.literal('codex'), kind: z.literal('home'), home: absolutePathSchema })
  .strict();
const explicitClaudeConfigDirCredentialSourceSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('claude'),
    kind: z.literal('config-dir'),
    configDir: absolutePathSchema,
    projectsRoot: absolutePathSchema,
    emitConfigDir: z.literal(true),
  })
  .strict();
const defaultClaudeConfigDirCredentialSourceSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('claude'),
    kind: z.literal('config-dir'),
    configDir: absolutePathSchema,
    projectsRoot: absolutePathSchema,
    emitConfigDir: z.literal(false),
    homeDir: absolutePathSchema,
  })
  .strict();
function validateClaudeProjectsRoot(source: { configDir: string; projectsRoot: string }, ctx: z.RefinementCtx): void {
  if (source.projectsRoot !== join(source.configDir, 'projects')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectsRoot'], message: 'projectsRoot must be derived' });
  }
}

export const providerCredentialSourceRefSchema = z
  .union([
    codexCredentialSourceSchema,
    explicitClaudeConfigDirCredentialSourceSchema,
    defaultClaudeConfigDirCredentialSourceSchema,
  ])
  .superRefine((source, ctx) => {
    if (source.provider === 'claude') validateClaudeProjectsRoot(source, ctx);
  })
  .describe('require-derived-claude-projects-root-for-source');
export type ProviderCredentialSourceRef = z.infer<typeof providerCredentialSourceRefSchema>;

export function providerRoutingEnv(source: ProviderCredentialSourceRef): Readonly<Record<string, string>> {
  if (source.provider === 'codex') return Object.freeze({ CODEX_HOME: source.home });
  return source.emitConfigDir
    ? Object.freeze({ CLAUDE_CONFIG_DIR: source.configDir })
    : Object.freeze({ HOME: source.homeDir });
}

export const PROVIDER_ROUTING_ENV_KEYS = Object.freeze(new Set(['CODEX_HOME', 'CLAUDE_CONFIG_DIR']));

export const PROVIDER_CREDENTIAL_OVERRIDE_ENV_KEYS = Object.freeze(
  new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CODEX_API_KEY',
    'CODEX_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
  ]),
);

export const UNSUPPORTED_CLAUDE_SELECTOR_ENV_KEYS = Object.freeze(
  new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]),
);

export const UNSUPPORTED_CODEX_SELECTOR_ENV_KEYS = Object.freeze(
  new Set([
    'CODEX_API_KEY',
    'CODEX_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
  ]),
);
