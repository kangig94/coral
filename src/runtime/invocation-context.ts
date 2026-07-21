import type { Principal } from '../security/principal.js';
import type { ProviderCredentialSet } from '../infra/provider-credential-sources.js';

export type InvocationContext = {
  projectRoot: string;
  pluginRoot: string;
  coralEnv: Record<string, string>;
  principal: Principal;
  /** Present for provider-launching requests; omitted from unrelated read paths. */
  providerCredentials?: ProviderCredentialSet;
};

export type ProviderInvocationContext = InvocationContext & {
  providerCredentials: ProviderCredentialSet;
};

export function hasProviderCredentials(ctx: InvocationContext): ctx is ProviderInvocationContext {
  return ctx.providerCredentials !== undefined;
}
