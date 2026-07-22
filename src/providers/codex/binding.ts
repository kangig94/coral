import { join } from 'node:path';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';

import {
  accountSubjectSchema,
  bindingFailure,
  bindingSuccess,
  type AccountSubject,
  type ProviderBinding,
  type ProviderBindingCodec,
  type ProviderBindingFailure,
  type ProviderBindingRuntime,
  type ProviderBindingResult,
} from '../contracts/binding.js';
import type { CodexCredentialSource } from './execution-context.js';
import type { JsonValue } from '../../infra/json-value.js';
import { absoluteProfilePathSchema, canonicalProfileDirectory } from '../contracts/profile.js';
import { CODEX_CREDENTIAL_ENV_KEYS } from './credential-policy.js';
import { unsupportedCodexTransportSetting } from './transport-policy.js';
import { zodPersistedParser, zodValueParser } from '../binding-parser.js';

function createCodexSelectionSchema() {
  return z.object({ kind: z.literal('home'), home: absoluteProfilePathSchema }).strict();
}

function createCodexCredentialProfileSchema() {
  return z
    .object({
      canonicalLocation: absoluteProfilePathSchema,
      routing: z.object({ kind: z.literal('home') }).strict(),
    })
    .strict();
}

function createCodexBindingSchema() {
  return z.object({ profile: createCodexCredentialProfileSchema(), subject: accountSubjectSchema }).strict();
}

export const codexSelectionSchema = createCodexSelectionSchema();
export type CodexSelection = z.infer<typeof codexSelectionSchema>;

export const codexCredentialProfileSchema = createCodexCredentialProfileSchema();
export type CodexCredentialProfile = z.infer<typeof codexCredentialProfileSchema>;

export const codexBindingSchema = createCodexBindingSchema();
export type CodexBinding = ProviderBinding<CodexCredentialProfile, AccountSubject>;

/** Capture one invocation's explicit or caller-local default Codex profile selector. */
export function captureCodexSelection(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): ProviderBindingResult<CodexSelection> {
  for (const [key, value] of Object.entries(env)) {
    if (value?.trim() && CODEX_CREDENTIAL_ENV_KEYS.has(key.toUpperCase())) {
      return bindingFailure({ reason: 'unsupported-selection', provider: 'codex', selector: key });
    }
  }
  const configured = env.CODEX_HOME;
  const home = configured !== undefined && configured.length > 0 ? configured : join(homeDir, '.codex');
  const parsed = codexSelectionSchema.safeParse({ kind: 'home', home });
  return parsed.success
    ? bindingSuccess(parsed.data)
    : bindingFailure<CodexSelection>({
        reason: 'unsupported-selection',
        provider: 'codex',
        selector: 'Codex home',
      });
}

function nonEmptyClaim(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jwtWorkspaceId(token: string): string | undefined {
  const payloadPart = token.split('.')[1];
  if (payloadPart === undefined || payloadPart.length === 0) return undefined;
  try {
    const payload = recordValue(JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as unknown);
    if (payload === undefined) return undefined;
    const auth = recordValue(payload['https://api.openai.com/auth']);
    return auth === undefined ? undefined : nonEmptyClaim(auth, 'chatgpt_account_id');
  } catch {
    return undefined;
  }
}

function introspectCodexSubject(
  profile: CodexCredentialProfile,
  runtime: ProviderBindingRuntime,
): ProviderBindingResult<AccountSubject> {
  let auth: Record<string, unknown> | undefined;
  try {
    auth = recordValue(
      JSON.parse(runtime.readFileSync(join(profile.canonicalLocation, 'auth.json'), 'utf-8')) as unknown,
    );
  } catch {
    // Credential bytes are deliberately discarded; failures are rendered from typed values.
  }
  const explicitAuthMode = nonEmptyClaim(auth ?? {}, 'auth_mode');
  const resolvedAuthMode =
    explicitAuthMode ??
    (nonEmptyClaim(auth ?? {}, 'personal_access_token') !== undefined
      ? 'personal_access_token'
      : nonEmptyClaim(auth ?? {}, 'bedrock_api_key') !== undefined
        ? 'bedrock_api_key'
        : nonEmptyClaim(auth ?? {}, 'OPENAI_API_KEY') !== undefined
          ? 'api_key'
          : 'chatgpt');
  if (resolvedAuthMode !== 'chatgpt') {
    return bindingFailure({ reason: 'identity-unavailable', provider: 'codex' });
  }
  const tokens = recordValue(auth?.tokens);
  if (tokens !== undefined) {
    const accountId = nonEmptyClaim(tokens, 'account_id');
    if (accountId !== undefined) {
      const idToken = nonEmptyClaim(tokens, 'id_token');
      const tokenWorkspaceId = idToken === undefined ? undefined : jwtWorkspaceId(idToken);
      if (tokenWorkspaceId !== undefined && tokenWorkspaceId !== accountId) {
        return bindingFailure({ reason: 'identity-unavailable', provider: 'codex' });
      }
      return bindingSuccess({ issuer: 'https://api.openai.com/chatgpt-account', subject: accountId });
    }
  }
  return bindingFailure({ reason: 'identity-unavailable', provider: 'codex' });
}

function unsupportedCodexConfigRouting(
  profile: CodexCredentialProfile,
  runtime: ProviderBindingRuntime,
): string | undefined {
  let entries: string[];
  try {
    entries = runtime.readdirSync(profile.canonicalLocation);
  } catch {
    return 'config.toml';
  }
  if (!entries.includes('config.toml')) return undefined;

  let config: string;
  try {
    config = runtime.readFileSync(join(profile.canonicalLocation, 'config.toml'), 'utf-8');
  } catch {
    return 'config.toml';
  }

  try {
    return unsupportedCodexTransportSetting(parseToml(config) as Record<string, unknown>);
  } catch {
    return 'config.toml';
  }
}

function validateCodexConfigRouting(
  profile: CodexCredentialProfile,
  runtime: ProviderBindingRuntime,
): ProviderBindingResult<true> {
  const selector = unsupportedCodexConfigRouting(profile, runtime);
  return selector === undefined
    ? bindingSuccess(true)
    : bindingFailure({
        reason: 'unsupported-selection',
        provider: 'codex',
        selector: `Codex config transport override '${selector}'`,
      });
}

export function renderCodexBindingFailure(failure: ProviderBindingFailure): string {
  switch (failure.reason) {
    case 'missing-profile':
      return 'No Codex credential profile was supplied. Select an absolute CODEX_HOME and retry.';
    case 'profile-unavailable':
      return `The selected ${failure.selector} is unavailable. Select an existing authenticated Codex profile and retry.`;
    case 'identity-unavailable':
      return 'The selected Codex profile does not expose a consistent workspace identity. Authenticate that CODEX_HOME and retry.';
    case 'profile-mismatch':
      return 'The selected Codex credential profile differs from this session. Resume with the original CODEX_HOME or start a new session.';
    case 'subject-mismatch':
      return 'The selected Codex profile is authenticated as a different workspace. Restore the original login or start a new session.';
    case 'unsupported-selection':
      return `The ${failure.selector} is not supported. Remove it and select an absolute CODEX_HOME.`;
    case 'invalid-persisted-binding':
      return 'The persisted Codex account binding is invalid. Start a new session.';
  }
}

export const codexBindingCodec: ProviderBindingCodec<
  CodexSelection,
  CodexCredentialProfile,
  AccountSubject & JsonValue,
  CodexCredentialSource
> = {
  parseSelection: zodValueParser(createCodexSelectionSchema),
  parseProfile: zodValueParser(createCodexCredentialProfileSchema),
  persistedBinding: zodPersistedParser(createCodexBindingSchema),
  bindingKind: 'account',
  captureSelection: ({ env, homeDir }) => captureCodexSelection(env, homeDir),
  async canonicalizeProfile(selection, runtime) {
    const canonicalLocation = canonicalProfileDirectory(runtime, selection.home);
    return canonicalLocation === undefined
      ? bindingFailure({ reason: 'profile-unavailable', provider: 'codex', selector: 'Codex home' })
      : bindingSuccess({ canonicalLocation, routing: { kind: 'home' } });
  },
  selectorLabel: () => 'Codex home',
  renderFailure: renderCodexBindingFailure,
  async bindProfile(profile, runtime) {
    if (canonicalProfileDirectory(runtime, profile.canonicalLocation) !== profile.canonicalLocation) {
      return bindingFailure({
        reason: 'profile-unavailable',
        provider: 'codex',
        selector: 'Codex credential profile',
      });
    }
    const routing = validateCodexConfigRouting(profile, runtime);
    if (!routing.ok) return routing;
    const subject = introspectCodexSubject(profile, runtime);
    return subject.ok ? bindingSuccess({ profile, subject: subject.value }) : subject;
  },
  async readiness(binding, use, runtime) {
    if (canonicalProfileDirectory(runtime, binding.profile.canonicalLocation) !== binding.profile.canonicalLocation) {
      return bindingFailure({
        reason: 'profile-unavailable',
        provider: 'codex',
        selector: 'Codex credential profile',
      });
    }
    const routing = validateCodexConfigRouting(binding.profile, runtime);
    if (!routing.ok) return routing;
    const subject = introspectCodexSubject(binding.profile, runtime);
    if (!subject.ok) return subject;
    return subject.value.issuer === binding.subject.issuer && subject.value.subject === binding.subject.subject
      ? bindingSuccess({ ready: true, use })
      : bindingFailure({ reason: 'subject-mismatch', provider: 'codex' });
  },
  credentialSource(binding) {
    return {
      home: binding.profile.canonicalLocation,
    };
  },
  compareBinding(left, right) {
    if (left.profile.canonicalLocation !== right.profile.canonicalLocation) {
      return bindingFailure({ reason: 'profile-mismatch', provider: 'codex' });
    }
    return left.subject.issuer === right.subject.issuer && left.subject.subject === right.subject.subject
      ? bindingSuccess(true)
      : bindingFailure({ reason: 'subject-mismatch', provider: 'codex' });
  },
  presentBinding: () => 'Codex workspace binding',
};
