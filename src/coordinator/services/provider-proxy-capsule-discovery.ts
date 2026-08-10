import { dirname, join } from 'node:path';

import { providerHandoffCapsulePath } from '../../infra/path/index.js';
import type { StoragePort } from '../../infra/port-types.js';
import {
  readHandoffCapsuleFile,
  type HandoffCapsule,
  type HandoffCapsuleFileEnvironment,
} from '../../provider-proxy/handoff-capsule.js';

const HANDOFF_CAPSULE_FILENAME = /^provider-1[0-9a-f]{23}\.handoff\.json$/u;

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
    const canonicalPath = providerHandoffCapsulePath(capsule, { baseDir });
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
