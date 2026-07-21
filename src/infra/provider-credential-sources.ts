import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import type { StoragePort } from './port-types.js';

/** Current profile-routing input captured at an invocation boundary; it is not verified account identity. */

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'Path must not contain NUL')
  .describe('reject-nul-in-provider-credential-path')
  .refine((value) => isAbsolute(value), 'Path must be absolute')
  .describe('require-absolute-provider-credential-path')
  .transform((value) => normalize(value))
  .describe('normalize-provider-credential-path');

const codexHomeInputSchema = z.object({ kind: z.literal('home'), home: absolutePathSchema }).strict();
const claudeConfigDirInputSchema = z.object({ kind: z.literal('config-dir'), configDir: absolutePathSchema }).strict();
const claudeAmbientInputSchema = z.object({ kind: z.literal('ambient') }).strict();

export const providerCredentialSetInputSchema = z
  .object({
    version: z.literal(1),
    codex: codexHomeInputSchema,
    claude: z.discriminatedUnion('kind', [claudeConfigDirInputSchema, claudeAmbientInputSchema]),
  })
  .strict();

export type ProviderCredentialSetInput = z.input<typeof providerCredentialSetInputSchema>;

const codexCredentialSourceSchema = z
  .object({ version: z.literal(1), provider: z.literal('codex'), kind: z.literal('home'), home: absolutePathSchema })
  .strict();
const claudeConfigDirCredentialSourceSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('claude'),
    kind: z.literal('config-dir'),
    configDir: absolutePathSchema,
    projectsRoot: absolutePathSchema,
  })
  .strict();
const claudeAmbientCredentialSourceSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('claude'),
    kind: z.literal('ambient'),
    configDirLocator: absolutePathSchema,
    projectsRoot: absolutePathSchema,
  })
  .strict();

function validateClaudeProjectsRoot(
  source: { configDir?: string; configDirLocator?: string; projectsRoot: string },
  ctx: z.RefinementCtx,
): void {
  const configRoot = source.configDir ?? source.configDirLocator;
  if (configRoot !== undefined && source.projectsRoot !== join(configRoot, 'projects')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectsRoot'], message: 'projectsRoot must be derived' });
  }
}

export const providerCredentialSourceRefSchema = z
  .union([codexCredentialSourceSchema, claudeConfigDirCredentialSourceSchema, claudeAmbientCredentialSourceSchema])
  .superRefine((source, ctx) => {
    if (source.provider === 'claude') validateClaudeProjectsRoot(source, ctx);
  })
  .describe('require-derived-claude-projects-root-for-source');
export type ProviderCredentialSourceRef = z.infer<typeof providerCredentialSourceRefSchema>;

export const providerCredentialSetSchema = z
  .object({
    version: z.literal(1),
    codex: codexCredentialSourceSchema,
    claude: z.discriminatedUnion('kind', [claudeConfigDirCredentialSourceSchema, claudeAmbientCredentialSourceSchema]),
  })
  .strict()
  .superRefine((credentials, ctx) => validateClaudeProjectsRoot(credentials.claude, ctx))
  .describe('require-derived-claude-projects-root-for-set');
export type ProviderCredentialSet = z.infer<typeof providerCredentialSetSchema>;

export interface AmbientClaudeLocationPort {
  locate(): { configDirLocator: string; projectsRoot: string };
}

export interface ProviderCredentialSourceAvailabilityPort {
  isAvailable(source: ProviderCredentialSourceRef): boolean;
}

export function filesystemProviderCredentialSourceAvailability(
  storage: Pick<StoragePort, 'statSync' | 'readdirSync'>,
): ProviderCredentialSourceAvailabilityPort {
  return {
    isAvailable(source) {
      const root =
        source.provider === 'codex'
          ? source.home
          : source.kind === 'config-dir'
            ? source.configDir
            : source.configDirLocator;
      try {
        if (!storage.statSync(root).isDirectory()) return false;
        storage.readdirSync(root);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function ambientClaudeLocation(homeDir: string): AmbientClaudeLocationPort {
  return {
    locate: () => {
      const configDirLocator = normalize(join(homeDir, '.claude'));
      return { configDirLocator, projectsRoot: join(configDirLocator, 'projects') };
    },
  };
}

export function captureProviderCredentialSetInput(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): ProviderCredentialSetInput {
  const codexHome = env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(homeDir, '.codex');
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR;
  return providerCredentialSetInputSchema.parse({
    version: 1,
    codex: { kind: 'home', home: codexHome },
    claude:
      claudeConfigDir && claudeConfigDir.length > 0
        ? { kind: 'config-dir', configDir: claudeConfigDir }
        : { kind: 'ambient' },
  });
}

export function canonicalizeProviderCredentialSet(
  input: ProviderCredentialSetInput,
  ambient: AmbientClaudeLocationPort,
): ProviderCredentialSet {
  const parsed = providerCredentialSetInputSchema.parse(input);
  const claude =
    parsed.claude.kind === 'config-dir'
      ? {
          version: 1 as const,
          provider: 'claude' as const,
          kind: 'config-dir' as const,
          configDir: parsed.claude.configDir,
          projectsRoot: join(parsed.claude.configDir, 'projects'),
        }
      : (() => {
          const location = ambient.locate();
          return claudeAmbientCredentialSourceSchema.parse({
            version: 1,
            provider: 'claude',
            kind: 'ambient',
            ...location,
          });
        })();
  return providerCredentialSetSchema.parse({
    version: 1,
    codex: { version: 1, provider: 'codex', kind: 'home', home: parsed.codex.home },
    claude,
  });
}

export function projectProviderCredentialSource(
  credentials: ProviderCredentialSet,
  provider: string,
): ProviderCredentialSourceRef {
  if (provider === 'codex') return credentials.codex;
  if (provider === 'claude') return credentials.claude;
  throw new Error(`unsupported_provider_credential_binding: ${provider}`);
}

export function providerCredentialSourceKey(source: ProviderCredentialSourceRef): string {
  const digest = createHash('sha256').update(providerCredentialSourceIdentity(source)).digest('hex').slice(0, 8);
  return `${source.provider}:${source.kind}:${digest}`;
}

function providerCredentialSourceIdentity(source: ProviderCredentialSourceRef): string {
  if (source.provider === 'codex') return JSON.stringify([source.version, source.provider, source.kind, source.home]);
  return source.kind === 'config-dir'
    ? JSON.stringify([source.version, source.provider, source.kind, source.configDir, source.projectsRoot])
    : JSON.stringify([source.version, source.provider, source.kind, source.configDirLocator, source.projectsRoot]);
}

export function sameProviderCredentialSource(
  left: ProviderCredentialSourceRef,
  right: ProviderCredentialSourceRef,
): boolean {
  return providerCredentialSourceIdentity(left) === providerCredentialSourceIdentity(right);
}

export function providerRoutingEnv(source: ProviderCredentialSourceRef): Readonly<Record<string, string>> {
  if (source.provider === 'codex') return Object.freeze({ CODEX_HOME: source.home });
  if (source.kind === 'config-dir') return Object.freeze({ CLAUDE_CONFIG_DIR: source.configDir });
  return Object.freeze({});
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
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]),
);
