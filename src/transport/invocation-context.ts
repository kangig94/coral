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
  // Caller-forwarded CORAL_* config is authoritative over the daemon's boot
  // snapshot. The daemon's own CORAL_* is frozen at boot, so a value the caller
  // changed — or removed from settings — after the daemon started would never
  // otherwise reach a spawned provider. Presence of the field (even an empty
  // map) is the authoritative signal: we drop the daemon's boot CORAL_* config
  // wholesale and replace it with the caller's, so a key the caller unset is
  // absent here too and the provider falls back to its code default. Daemon-owned
  // identity/secret/lineage and boot-fixed keys are kept from the snapshot (never
  // taken from this untrusted map) and, for lineage, set from the validated
  // jobId/sessionId fields below. The delete is scoped to CORAL_* keys: the
  // snapshot is CORAL_-prefix-only today (runtime coralSnapshot()), and the guard
  // keeps this correct if that ever changes.
  const forwardedCoralEnv = readForwardedCoralEnv(body.coralEnv);
  if (forwardedCoralEnv !== undefined) {
    for (const key of Object.keys(env)) {
      if (key.startsWith('CORAL_') && !DAEMON_OWNED_CORAL_ENV_KEYS.has(key)) {
        delete env[key];
      }
    }
    Object.assign(env, forwardedCoralEnv);
  }
  // Caller-forwarded proxy/CA env overlays the daemon's boot snapshot so the
  // spawned provider sees the invoking shell's network settings. These keys
  // intentionally ride in the controller env (coralEnv), not a separate field:
  // that is what carries them into the claude `envHash` and the codex host spec,
  // so a changed proxy correctly re-bootstraps rather than reusing a stale one.
  // Do not split this out. Read only the recognized keys with non-empty string
  // values — the body is untrusted wire input.
  const networkEnv = body.networkEnv;
  if (networkEnv !== null && typeof networkEnv === 'object') {
    for (const key of FORWARDED_NETWORK_ENV_KEYS) {
      const value = (networkEnv as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.length > 0) {
        env[key] = value;
      }
    }
  }
  // owner/effort/claudeModelCap/claudeTransport also travel as dedicated,
  // strictly-validated body fields — the only channel remote callers may use
  // (coralEnv is loopback-only). This overlay runs after the coralEnv block, so
  // the dedicated field intentionally wins over any coralEnv-forwarded copy of
  // the same key. Do not delete either path as redundant: the dedicated fields
  // are the remote-safe, strictly-typed source; coralEnv is the local bulk one.
  for (const field of TRANSPORT_CONTEXT_FIELDS) {
    const value = body[field];
    if (typeof value === 'string') {
      env[CONTEXT_ENV_KEY[field]] = value;
    }
  }
  if (typeof body.jobId === 'string' && body.jobId.length > 0) {
    env.CORAL_JOB_ID = body.jobId;
  }
  if (typeof body.sessionId === 'string' && body.sessionId.length > 0) {
    env.CORAL_SESSION_ID = body.sessionId;
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
