import { join } from 'node:path';
import { z } from 'zod';

import {
  bindingFailure,
  bindingSuccess,
  type AccountSubject,
  type ProviderBindingCodec,
  type ProviderBindingFailure,
  type ProviderBindingResult,
} from '../contracts/binding.js';
import type { JsonValue } from '../../infra/json-value.js';
import type { ClaudeProviderAccess } from './execution-plan.js';
import { absoluteProfilePathSchema, canonicalProfileDirectory } from '../contracts/profile.js';
import { isClaudeCredentialEnvKey } from './credential-policy.js';
import { zodPersistedParser, zodValueParser } from '../binding-parser.js';
import { claudePersistedContinuityParser } from './request-mapping.js';

function createClaudeSelectionSchema() {
  return z.union([
    z
      .object({ kind: z.literal('config-dir'), configDir: absoluteProfilePathSchema, emitConfigDir: z.literal(true) })
      .strict(),
    z
      .object({
        kind: z.literal('config-dir'),
        configDir: absoluteProfilePathSchema,
        emitConfigDir: z.literal(false),
        homeDir: absoluteProfilePathSchema,
      })
      .strict(),
  ]);
}

function createClaudeCredentialProfileSchema() {
  const routing = z.union([
    z.object({ kind: z.literal('config-dir'), emitConfigDir: z.literal(true) }).strict(),
    z
      .object({ kind: z.literal('config-dir'), emitConfigDir: z.literal(false), homeDir: absoluteProfilePathSchema })
      .strict(),
  ]);
  return z.object({ canonicalLocation: absoluteProfilePathSchema, routing }).strict();
}

function createClaudeBindingSchema() {
  return z.object({ profile: createClaudeCredentialProfileSchema(), guarantee: z.literal('profile-only') }).strict();
}

export const claudeSelectionSchema = createClaudeSelectionSchema();
export type ClaudeSelection = z.infer<typeof claudeSelectionSchema>;

export const claudeCredentialProfileSchema = createClaudeCredentialProfileSchema();
export type ClaudeCredentialProfile = z.infer<typeof claudeCredentialProfileSchema>;

export function captureClaudeSelection(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): ProviderBindingResult<ClaudeSelection> {
  for (const [key, value] of Object.entries(env)) {
    if (value?.trim() && isClaudeCredentialEnvKey(key.toUpperCase())) {
      return bindingFailure<ClaudeSelection>({
        reason: 'unsupported-selection',
        provider: 'claude',
        selector: key,
      });
    }
  }
  const configured = env.CLAUDE_CONFIG_DIR;
  const emitConfigDir = configured !== undefined && configured.length > 0;
  const configDir = emitConfigDir ? configured : join(homeDir, '.claude');
  const parsed = claudeSelectionSchema.safeParse(
    emitConfigDir
      ? { kind: 'config-dir', configDir, emitConfigDir: true }
      : { kind: 'config-dir', configDir, emitConfigDir: false, homeDir },
  );
  return parsed.success
    ? bindingSuccess(parsed.data)
    : bindingFailure<ClaudeSelection>({
        reason: 'unsupported-selection',
        provider: 'claude',
        selector: 'Claude config directory',
      });
}

export function renderClaudeBindingFailure(failure: ProviderBindingFailure): string {
  switch (failure.reason) {
    case 'missing-profile':
      return 'No Claude credential profile was supplied. Select an absolute CLAUDE_CONFIG_DIR and retry.';
    case 'profile-unavailable':
      return `The selected ${failure.selector} is unavailable. Select an existing authenticated Claude profile and retry.`;
    case 'identity-unavailable':
      return 'Claude cannot verify account identity because this provider supports profile-level binding only. Resume with the original Claude credential profile or start a new session.';
    case 'profile-mismatch':
      return 'The selected Claude credential profile differs from this session. Resume with the original profile or start a new session.';
    case 'subject-mismatch':
      return 'The selected Claude credential profile no longer resolves to the bound account. Restore the original Claude credential profile or start a new session.';
    case 'unsupported-selection':
      return `The ${failure.selector} is not supported. Remove it and select an absolute CLAUDE_CONFIG_DIR.`;
    case 'invalid-persisted-binding':
      return 'The persisted Claude credential binding is invalid. Start a new session.';
  }
}

export const claudeBindingCodec: ProviderBindingCodec<
  ClaudeSelection,
  ClaudeCredentialProfile,
  AccountSubject & JsonValue,
  ClaudeProviderAccess
> = {
  parseSelection: zodValueParser(createClaudeSelectionSchema),
  persistedProfile: zodPersistedParser(createClaudeCredentialProfileSchema),
  persistedContinuity: claudePersistedContinuityParser,
  persistedBinding: zodPersistedParser(createClaudeBindingSchema),
  bindingKind: 'profile',
  captureSelection: ({ env, homeDir }) => captureClaudeSelection(env, homeDir),
  async canonicalizeProfile(selection, runtime) {
    const canonicalLocation = canonicalProfileDirectory(runtime, selection.configDir);
    if (canonicalLocation === undefined) {
      return bindingFailure({
        reason: 'profile-unavailable',
        provider: 'claude',
        selector: 'Claude config directory',
      });
    }
    return bindingSuccess({
      canonicalLocation,
      routing: selection.emitConfigDir
        ? { kind: 'config-dir', emitConfigDir: true }
        : { kind: 'config-dir', emitConfigDir: false, homeDir: selection.homeDir },
    });
  },
  selectorLabel: () => 'Claude config directory',
  renderFailure: renderClaudeBindingFailure,
  async bindProfile(profile, runtime) {
    const canonicalLocation = canonicalProfileDirectory(runtime, profile.canonicalLocation);
    const defaultLocation = profile.routing.emitConfigDir
      ? profile.canonicalLocation
      : canonicalProfileDirectory(runtime, join(profile.routing.homeDir, '.claude'));
    return canonicalLocation === profile.canonicalLocation && defaultLocation === profile.canonicalLocation
      ? bindingSuccess({ profile, guarantee: 'profile-only' })
      : bindingFailure({
          reason: 'profile-unavailable',
          provider: 'claude',
          selector: 'Claude credential profile',
        });
  },
  async readiness(binding, use, runtime) {
    const profile = binding.profile;
    const canonicalLocation = canonicalProfileDirectory(runtime, profile.canonicalLocation);
    const defaultLocation = profile.routing.emitConfigDir
      ? profile.canonicalLocation
      : canonicalProfileDirectory(runtime, join(profile.routing.homeDir, '.claude'));
    return canonicalLocation !== profile.canonicalLocation || defaultLocation !== profile.canonicalLocation
      ? bindingFailure({
          reason: 'profile-unavailable',
          provider: 'claude',
          selector: 'Claude credential profile',
        })
      : bindingSuccess({ ready: true, use });
  },
  access(binding) {
    if (!binding.profile.routing.emitConfigDir) {
      return {
        configDir: binding.profile.canonicalLocation,
        projectsRoot: join(binding.profile.canonicalLocation, 'projects'),
        routing: { kind: 'default-home', homeDir: binding.profile.routing.homeDir },
      };
    }
    return {
      configDir: binding.profile.canonicalLocation,
      projectsRoot: join(binding.profile.canonicalLocation, 'projects'),
      routing: { kind: 'config-dir' },
    };
  },
  compareBinding: (left, right) =>
    left.profile.canonicalLocation === right.profile.canonicalLocation &&
    left.profile.routing.emitConfigDir === right.profile.routing.emitConfigDir &&
    (left.profile.routing.emitConfigDir ||
      (!right.profile.routing.emitConfigDir && left.profile.routing.homeDir === right.profile.routing.homeDir))
      ? bindingSuccess(true)
      : bindingFailure({ reason: 'profile-mismatch', provider: 'claude' }),
  presentBinding: () => 'Claude credential profile',
};
