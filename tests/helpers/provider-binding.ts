import { z } from 'zod';

import {
  bindingFailure,
  bindingSuccess,
  type ProviderBindingCodec,
  type ProviderBindingFailure,
} from '#src/providers/contracts/binding.js';
import type { ProviderCredentialSourceRef } from '#src/infra/provider-credential-sources.js';

const selectionSchema = z.object({ key: z.string() }).strict();
const profileSchema = z
  .object({
    canonicalLocation: z.string(),
    routing: z.union([
      z.object({ kind: z.literal('home') }).strict(),
      z.object({ kind: z.literal('config-dir'), emitConfigDir: z.literal(true) }).strict(),
      z.object({}).strict(),
    ]),
  })
  .strict();
const bindingSchema = z.object({ profile: profileSchema, guarantee: z.literal('profile-only') }).strict();
const accountBindingSchema = z
  .object({
    profile: profileSchema,
    subject: z.object({ issuer: z.string(), subject: z.string() }).strict(),
  })
  .strict();

export function fixtureProviderBindingCodec(
  provider: string,
  options: {
    readinessFailure?: ProviderBindingFailure;
    accountSubject?: (profile: z.infer<typeof profileSchema>) => {
      readonly issuer: string;
      readonly subject: string;
    };
  } = {},
): ProviderBindingCodec<z.infer<typeof selectionSchema>, z.infer<typeof profileSchema>> {
  const base = {
    selectionSchema,
    profileSchema,
    captureSelection: () => bindingSuccess({ key: provider }),
    async canonicalizeProfile(selection: z.infer<typeof selectionSchema>) {
      return bindingSuccess({ canonicalLocation: `/${selection.key}`, routing: {} });
    },
    selectorLabel: () => `${provider} fixture selector`,
    renderFailure: (failure: ProviderBindingFailure) => `${provider} fixture binding failed: ${failure.reason}`,
  };
  const credentialSource = (binding: { profile: z.infer<typeof profileSchema> }): ProviderCredentialSourceRef => {
    return provider === 'claude'
      ? {
          version: 1,
          provider: 'claude',
          kind: 'config-dir',
          configDir: binding.profile.canonicalLocation,
          projectsRoot: `${binding.profile.canonicalLocation}/projects`,
          emitConfigDir:
            'kind' in binding.profile.routing && binding.profile.routing.kind === 'config-dir'
              ? binding.profile.routing.emitConfigDir
              : true,
        }
      : {
          version: 1,
          provider: 'codex',
          kind: 'home',
          home: binding.profile.canonicalLocation,
        };
  };
  if (provider === 'codex') {
    const currentSubject = (profile: z.infer<typeof profileSchema>) =>
      options.accountSubject?.(profile) ?? {
        issuer: 'https://api.openai.com/chatgpt-account',
        subject: 'test-account',
      };
    return {
      ...base,
      bindingSchema: accountBindingSchema,
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
      credentialSource,
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
    bindingSchema,
    bindingKind: 'profile',
    async bindProfile(profile) {
      return bindingSuccess({ profile, guarantee: 'profile-only' });
    },
    async readiness(_binding, use) {
      return options.readinessFailure === undefined
        ? bindingSuccess({ ready: true, use })
        : bindingFailure(options.readinessFailure);
    },
    credentialSource,
    compareBinding: (left, right) =>
      left.profile.canonicalLocation === right.profile.canonicalLocation
        ? bindingSuccess(true)
        : bindingFailure({ reason: 'profile-mismatch', provider }),
    presentBinding: () => `${provider} fixture profile`,
  };
}
