import type { Principal } from '../security/principal.js';
import type { ProviderScope } from '../infra/provider-scope.js';

export type InvocationContext = {
  projectRoot: string;
  pluginRoot: string;
  coralEnv: Record<string, string>;
  principal: Principal;
  /** Present for provider-launching requests; omitted from unrelated read paths. */
  providerScope?: ProviderScope;
};

export type ProviderInvocationContext = InvocationContext & {
  providerScope: ProviderScope;
};

export function hasProviderScope(ctx: InvocationContext): ctx is ProviderInvocationContext {
  return ctx.providerScope !== undefined;
}
