import { dirname, join } from 'node:path';

import { providerHandoffCapsulePath } from '../../infra/path/index.js';
import type { StoragePort } from '../../infra/port-types.js';
import {
  readHandoffCapsuleFile,
  type HandoffCapsule,
  type HandoffCapsuleFileEnvironment,
} from '../../provider-proxy/handoff-capsule.js';

/**
 * Exactly the generations this build can decode, and no others.
 *
 * The format generation lives in the filename so a build never opens a capsule it cannot parse — refusing one
 * is a *fatal* startup error, so the only safe way to meet a foreign generation is not to meet it. That has to
 * hold in both directions. Matching `.v<n>` for any n would make this build discover a future `.v4.json`, hand
 * it to a decoder that knows V1 through V3, and abort the boot of the very build someone rolled back to — the
 * failure this mechanism exists to prevent, pointing the other way.
 *
 * So this pattern names its generations one at a time and grows only when the decoder does. The unsuffixed
 * name is V1 and V2, which shipped before the suffix existed and must still be found in order to be refused.
 */
const HANDOFF_CAPSULE_FILENAME = /^provider-1[0-9a-f]{23}\.handoff(\.v3)?\.json$/u;

export type DiscoveredProviderHandoffCapsule = Readonly<{
  path: string;
  capsule: HandoffCapsule;
}>;

export function discoverProviderHandoffCapsules(
  options: Readonly<{
    runDir: string;
    generationRoot: string;
    storage: StoragePort;
    uid: number;
  }>,
): readonly DiscoveredProviderHandoffCapsule[] {
  const env: HandoffCapsuleFileEnvironment = { storage: options.storage, uid: options.uid };
  const baseDir = dirname(options.generationRoot);
  const candidates = options.storage
    .readdirSync(options.runDir)
    .filter((entry) => HANDOFF_CAPSULE_FILENAME.test(entry))
    .sort();

  return candidates.map((entry) => {
    const path = join(options.runDir, entry);
    const capsule = readHandoffCapsuleFile(path, env);
    if (capsule === null) throw new Error(`provider_proxy_handoff_capsule_disappeared:${path}`);
    // The capsule's own version, not this build's: an older generation is canonical at the name it shipped
    // under, and holding it to the current one would read every legacy capsule as relocated.
    const canonicalPath = providerHandoffCapsulePath(capsule, { baseDir }, capsule.version);
    if (canonicalPath !== path) throw new Error(`provider_proxy_handoff_capsule_path_mismatch:${path}`);
    return Object.freeze({ path, capsule });
  });
}

export type ProviderHandoffCapsuleRetirementOutcome =
  | Readonly<{ kind: 'retired' }>
  | Readonly<{
      kind: 'temporarily-unavailable';
      incident: Readonly<{ kind: 'capsule-directory-durability-unavailable' }>;
    }>;

export function retireProviderHandoffCapsule(
  storage: StoragePort,
  path: string,
): ProviderHandoffCapsuleRetirementOutcome {
  try {
    storage.unlinkSync(path);
  } catch (error: unknown) {
    if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') throw error;
  }
  return storage.syncDirectoryDurableSync(dirname(path))
    ? { kind: 'retired' }
    : {
        kind: 'temporarily-unavailable',
        incident: { kind: 'capsule-directory-durability-unavailable' },
      };
}
