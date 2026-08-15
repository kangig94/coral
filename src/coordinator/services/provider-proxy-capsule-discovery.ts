import { dirname, join } from 'node:path';

import { providerHandoffCapsulePath } from '../../infra/path/index.js';
import type { StoragePort } from '../../infra/port-types.js';
import {
  readHandoffCapsuleFile,
  type HandoffCapsule,
  type HandoffCapsuleFileEnvironment,
} from '../../provider-proxy/handoff-capsule.js';

/**
 * Both names, because this build must find every capsule that exists — the generations it wrote and the ones
 * older builds left. The optional `.v<n>` is the format generation, which lives in the filename so a build
 * that predates a generation never opens its files (see `providerHandoffCapsulePath`). v0.10.8's own copy of
 * this pattern has no such branch, which is exactly the point: to it, a `.handoff.v3.json` is not a capsule.
 */
const HANDOFF_CAPSULE_FILENAME = /^provider-1[0-9a-f]{23}\.handoff(\.v[0-9]+)?\.json$/u;

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
