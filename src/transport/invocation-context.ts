import {
  DAEMON_OWNED_CORAL_ENV_KEYS,
  invocationCoralEnvSnapshot,
  readForwardedCoralEnv,
} from '../infra/env-sanitize.js';
import { FORWARDED_NETWORK_ENV_KEYS } from '../infra/network-env.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { ProviderScope } from '../infra/provider-scope.js';
import type { Principal } from '../security/principal.js';
import { CONTEXT_ENV_KEY, TRANSPORT_CONTEXT_FIELDS } from './context-profile.js';

export function buildControllerEnv(
  body: Record<string, unknown>,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = invocationCoralEnvSnapshot(coralEnvSnapshot);
  // Untrusted forwarding must not replace daemon-owned identity, secrets, lineage, or boot-fixed keys.
  const forwardedCoralEnv = readForwardedCoralEnv(body.coralEnv);
  if (forwardedCoralEnv !== undefined) {
    for (const key of Object.keys(env)) {
      if (key.startsWith('CORAL_') && !DAEMON_OWNED_CORAL_ENV_KEYS.has(key)) {
        delete env[key];
      }
    }
    Object.assign(env, forwardedCoralEnv);
  }
  const networkEnv = body.networkEnv;
  if (networkEnv !== null && typeof networkEnv === 'object') {
    for (const key of FORWARDED_NETWORK_ENV_KEYS) {
      const value = (networkEnv as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) {
        env[key] = value;
      }
    }
  }
  for (const field of TRANSPORT_CONTEXT_FIELDS) {
    const value = body[field];
    if (typeof value === 'string') {
      env[CONTEXT_ENV_KEY[field]] = value;
    }
  }
  if (typeof body.jobId === 'string' && body.jobId.length > 0) {
    env.CORAL_JOB_ID = body.jobId;
  }
  return env;
}

export function buildInvocationContext(
  body: Record<string, unknown>,
  projectRoot: CanonicalWorkDir,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
  principal: Principal,
  providerScope?: ProviderScope,
): InvocationContext | null {
  return {
    projectRoot,
    pluginRoot,
    coralEnv: buildControllerEnv(body, coralEnvSnapshot),
    principal,
    ...(providerScope === undefined ? {} : { providerScope }),
  };
}

export function buildInvocationContextFromQuery(
  projectRoot: CanonicalWorkDir,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
  principal: Principal,
): InvocationContext {
  return { projectRoot, pluginRoot, coralEnv: invocationCoralEnvSnapshot(coralEnvSnapshot), principal };
}
