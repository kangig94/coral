import type { Principal } from '../security/principal.js';

export type InvocationContext = {
  projectRoot: string;
  pluginRoot: string;
  coralEnv: Record<string, string>;
  principal: Principal;
};
