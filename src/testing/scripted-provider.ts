export {
  CORAL_SCRIPTED_PROVIDER_SPEC_ENV,
  readScriptedProviderSpecFromEnv,
  scriptedProviderSpecSchema,
  type ScriptedProviderSpec,
} from '../providers/bootstrap-scripted-override.js';

import {
  CORAL_SCRIPTED_PROVIDER_SPEC_ENV,
  resolveScriptedProviderOverride,
  type ScriptedProviderSpec,
} from '../providers/bootstrap-scripted-override.js';
import type { ProviderSpec } from '../providers/contract.js';

export function createScriptedProvider(spec: ScriptedProviderSpec): ProviderSpec {
  const provider = resolveScriptedProviderOverride({
    [CORAL_SCRIPTED_PROVIDER_SPEC_ENV]: JSON.stringify(spec),
  });
  if (provider === null) {
    throw new Error('Expected scripted provider override to resolve a provider spec.');
  }
  return provider;
}
