import { dirname, join } from 'node:path';

import { providerHandoffCapsuleFileSuffix, providerHandoffCapsulePath } from '../infra/path/index.js';
import type { StoragePort } from '../infra/port-types.js';
import {
  SUPPORTED_HANDOFF_CAPSULE_VERSIONS,
  readHandoffCapsuleFile,
  type HandoffCapsule,
  type HandoffCapsuleFileEnvironment,
} from './handoff-capsule.js';

/** Only generations this build can decode may become discovery candidates. */
const HANDOFF_CAPSULE_FILENAME = new RegExp(
  `^provider-1[0-9a-f]{23}\\.(?:${[
    ...new Set(SUPPORTED_HANDOFF_CAPSULE_VERSIONS.map((version) => providerHandoffCapsuleFileSuffix(version))),
  ]
    .map((suffix) => suffix.replaceAll('.', '\\.'))
    .join('|')})$`,
  'u',
);

export type ProviderHandoffCapsuleCandidateRead =
  | Readonly<{ kind: 'readable'; path: string; capsule: HandoffCapsule }>
  | Readonly<{
      kind: 'invalid';
      path: string;
      reason: 'provider_proxy_handoff_capsule_disappeared' | 'provider_proxy_handoff_capsule_path_mismatch';
    }>;

/** Unsupported capsule generations must remain invisible to this build's decoder. */
export function providerHandoffCapsuleCandidatePaths(
  runDir: string,
  storage: Pick<StoragePort, 'readdirSync'>,
): readonly string[] {
  return storage
    .readdirSync(runDir)
    .filter((entry) => HANDOFF_CAPSULE_FILENAME.test(entry))
    .sort()
    .map((entry) => join(runDir, entry));
}

/** Canonical addressing is judged against the decoded capsule's own version. */
export function readProviderHandoffCapsuleCandidate(
  path: string,
  generationRoot: string,
  environment: HandoffCapsuleFileEnvironment,
): ProviderHandoffCapsuleCandidateRead {
  const capsule = readHandoffCapsuleFile(path, environment);
  if (capsule === null) {
    return { kind: 'invalid', path, reason: 'provider_proxy_handoff_capsule_disappeared' };
  }

  const canonicalPath = providerHandoffCapsulePath(capsule, capsule.version, {
    baseDir: dirname(generationRoot),
  });
  if (canonicalPath !== path) {
    return { kind: 'invalid', path, reason: 'provider_proxy_handoff_capsule_path_mismatch' };
  }
  return { kind: 'readable', path, capsule };
}
