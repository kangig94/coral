import { z } from 'zod';

/**
 * Network/TLS environment variables forwarded from the invoking shell to
 * provider children (the shared `claude`/`codex` brokers).
 *
 * Why only these, and why forward them at all: the backend is a long-lived
 * shared daemon whose `process.env` is frozen at boot. A proxy or CA bundle
 * exported in the caller's shell *after* the daemon started would otherwise
 * never reach a spawned provider. These keys are stable within a shell session,
 * so forwarding them keeps broker identity (claude `envHash` / codex host key)
 * stable — a genuinely different proxy correctly yields a separate broker
 * instead of churning the shared one. Volatile per-terminal vars are
 * deliberately NOT forwarded, which is what keeps that identity stable.
 *
 * Both upper- and lower-case spellings are listed because tooling disagrees on
 * which it reads; whichever spelling the caller actually set is forwarded
 * verbatim.
 */
export const FORWARDED_NETWORK_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * Empty values are dropped so an exported-but-empty var does not mask
 * the daemon's own setting.
 */
export function collectForwardedNetworkEnv(source: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of FORWARDED_NETWORK_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * The enum-key restriction is the reject-unknown-keys guard at
 * RPC ingress; `buildControllerEnv` re-applies the same allowlist defensively
 * on the untrusted body object before it builds the child env.
 */
export const networkEnvSchema = z.record(z.enum(FORWARDED_NETWORK_ENV_KEYS), z.string().min(1));
