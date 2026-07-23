import { z } from 'zod';

import {
  bindingFailure,
  bindingSuccess,
  type ProviderBindingCodec,
  type ProviderBindingFailure,
} from '#src/providers/contracts/binding.js';
import { zodPersistedParser, zodValueParser } from '#src/providers/binding-parser.js';

export type FixtureProviderAccess = {
  readonly root: string;
  readonly routingEnv: Readonly<Record<string, string>>;
};

function createSelectionSchema() {
  return z.object({ key: z.string() }).strict();
}

function createProfileSchema() {
  return z
    .object({
      canonicalLocation: z.string(),
      routing: z.union([
        z.object({ kind: z.literal('home') }).strict(),
        z.object({ kind: z.literal('config-dir'), emitConfigDir: z.literal(true) }).strict(),
        z.object({}).strict(),
      ]),
    })
    .strict();
}

function createBindingSchema() {
  return z.object({ profile: createProfileSchema(), guarantee: z.literal('profile-only') }).strict();
}

function createAccountBindingSchema() {
  return z
    .object({
      profile: createProfileSchema(),
      subject: z.object({ issuer: z.string(), subject: z.string() }).strict(),
    })
    .strict();
}

type FixtureSelection = z.infer<ReturnType<typeof createSelectionSchema>>;
type FixtureProfile = z.infer<ReturnType<typeof createProfileSchema>>;
type FixtureAccountSubject = z.infer<ReturnType<typeof createAccountBindingSchema>>['subject'];

export function fixtureProviderBindingCodec(
  provider: string,
  options: {
    readinessFailure?: ProviderBindingFailure;
    accountSubject?: (profile: FixtureProfile) => {
      readonly issuer: string;
      readonly subject: string;
    };
  } = {},
): ProviderBindingCodec<FixtureSelection, FixtureProfile, FixtureAccountSubject, FixtureProviderAccess> {
  const base = {
    parseSelection: zodValueParser(createSelectionSchema),
    persistedProfile: zodPersistedParser(createProfileSchema),
    persistedContinuity: zodPersistedParser(() => z.record(z.string(), z.unknown())),
    captureSelection: () => bindingSuccess({ key: provider }),
    async canonicalizeProfile(selection: FixtureSelection) {
      return bindingSuccess({ canonicalLocation: `/${selection.key}`, routing: {} });
    },
    selectorLabel: () => `${provider} fixture selector`,
    renderFailure: (failure: ProviderBindingFailure) => `${provider} fixture binding failed: ${failure.reason}`,
  };
  const access = (binding: { profile: FixtureProfile }): FixtureProviderAccess => {
    const routingEnv: Record<string, string> =
      provider === 'claude'
        ? { CLAUDE_CONFIG_DIR: binding.profile.canonicalLocation }
        : provider === 'codex'
          ? { CODEX_HOME: binding.profile.canonicalLocation }
          : { FIXTURE_PROFILE_ROOT: binding.profile.canonicalLocation };
    return Object.freeze({ root: binding.profile.canonicalLocation, routingEnv: Object.freeze(routingEnv) });
  };
  if (provider === 'codex') {
    const currentSubject = (profile: FixtureProfile) =>
      options.accountSubject?.(profile) ?? {
        issuer: 'https://api.openai.com/chatgpt-account',
        subject: 'test-account',
      };
    return {
      ...base,
      persistedBinding: zodPersistedParser(createAccountBindingSchema),
      bindingKind: 'account',
      async bindProfile(profile) {
        return bindingSuccess({
          profile,
          subject: currentSubject(profile),
        });
      },
      async readiness(binding, use) {
        if (options.readinessFailure !== undefined) return bindingFailure(options.readinessFailure);
        const subject = currentSubject(binding.profile);
        return binding.subject.issuer === subject.issuer && binding.subject.subject === subject.subject
          ? bindingSuccess({ ready: true, use })
          : bindingFailure({ reason: 'subject-mismatch', provider });
      },
      access,
      compareBinding(left, right) {
        if (left.profile.canonicalLocation !== right.profile.canonicalLocation) {
          return bindingFailure({ reason: 'profile-mismatch', provider });
        }
        return left.subject.issuer === right.subject.issuer && left.subject.subject === right.subject.subject
          ? bindingSuccess(true)
          : bindingFailure({ reason: 'subject-mismatch', provider });
      },
      presentBinding: () => `${provider} fixture account`,
    };
  }
  return {
    ...base,
    persistedBinding: zodPersistedParser(createBindingSchema),
    bindingKind: 'profile',
    async bindProfile(profile) {
      return bindingSuccess({ profile, guarantee: 'profile-only' });
    },
    async readiness(_binding, use) {
      return options.readinessFailure === undefined
        ? bindingSuccess({ ready: true, use })
        : bindingFailure(options.readinessFailure);
    },
    access,
    compareBinding: (left, right) =>
      left.profile.canonicalLocation === right.profile.canonicalLocation
        ? bindingSuccess(true)
        : bindingFailure({ reason: 'profile-mismatch', provider }),
    presentBinding: () => `${provider} fixture profile`,
  };
}
