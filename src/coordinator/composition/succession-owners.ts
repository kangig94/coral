import type { Runtime } from '../../runtime/ports.js';
import type { JobStore } from '../../jobs/store.js';
import { type createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { type RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import type { LifecycleController } from '../lifecycle.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import type { ProviderHostAdministrationAuthority } from '../live/provider-hosts/index.js';
import type { SuccessionOwner } from '../succession/obligations.js';
import { type createProviderHostTransfer } from '../succession/provider-host-transfer.js';
import { type createCoordinatorWorld } from './world.js';
import { createLaunchSuccessionOwners } from './succession-owners/launch-admission.js';
import { createLocalAuthoritySuccessionOwners } from './succession-owners/local-authority.js';
import { createChildPrincipalSuccessionOwner } from './succession-owners/child-principals.js';

export function createSuccessionOwners(input: {
  runtime: Runtime;
  world: ReturnType<typeof createCoordinatorWorld>;
  getProgressStore: () => JobStore;
  getRecoveryQuarantineStore: () => RecoveryQuarantineStore;
  lifecycleController: () => LifecycleController | null;
  kbDaemonSupervisor: KbDaemonSupervisor;
  discuss: ReturnType<typeof createDiscussRuntime>;
  providerHostTransfer: ReturnType<typeof createProviderHostTransfer>;
  liveProviderHosts: () => ReturnType<ProviderHostAdministrationAuthority['listProviderHosts']>;
  readSuccessionJobs: () => readonly string[];
  isTerminalDiscussStatus: (status: string) => boolean;
}): readonly SuccessionOwner[] {
  const { providerHostTransfer } = input;
  return [
    ...createLaunchSuccessionOwners(input),
    ...providerHostTransfer.owners,
    ...createLocalAuthoritySuccessionOwners(input),
    createChildPrincipalSuccessionOwner(input),
  ];
}
