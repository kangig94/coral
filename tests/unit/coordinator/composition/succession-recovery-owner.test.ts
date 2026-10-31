import { describe, expect, it } from 'vitest';

import type { SuccessionOwnersInput } from '#src/coordinator/composition/succession-owners/index.js';
import { createLocalAuthoritySuccessionOwners } from '#src/coordinator/composition/succession-owners/local-authority.js';
import type { SupersededProviderOperationMaintenancePass } from '#src/coordinator/services/recovery/superseded-provider-operations.js';

const JOB = '00000000-0000-4000-8000-000000000001';

function recoveryOwner(
  settle: () => Promise<SupersededProviderOperationMaintenancePass | null>,
  quarantines: unknown[],
) {
  const input = {
    getProgressStore: () => ({ readRuntimeProjection: () => null }),
    getRecoveryQuarantineStore: () => ({ list: () => quarantines }),
    lifecycleController: () => ({ getRecoveryRegistry: () => null, settleSupersededProviderOperations: settle }),
  } as unknown as SuccessionOwnersInput;
  const owner = createLocalAuthoritySuccessionOwners(input).find(({ id }) => id === 'recovery');
  if (owner === undefined) throw new Error('no recovery succession owner');
  return owner;
}

describe('recovery succession owner', () => {
  it('should settle superseded provider operations before reading the quarantine that names them', async () => {
    const quarantines: unknown[] = [{ boundary: 'unreadable-provider-operation' }];
    const owner = recoveryOwner(async () => {
      quarantines.length = 0;
      return { kind: 'settled' };
    }, quarantines);

    await expect(owner.classify('attempt-1', {} as never)).resolves.toMatchObject({ kind: 'completed' });
  });

  it('should block the succession while a superseded row still fences its job', async () => {
    const owner = recoveryOwner(
      async () => ({
        kind: 'holding',
        retainedRows: 0,
        unreleasedRows: [],
        unadoptedRecords: [],
        pendingJobIds: [JOB],
      }),
      [],
    );

    await expect(owner.classify('attempt-1', {} as never)).resolves.toMatchObject({
      kind: 'blocking',
      jobIds: [JOB],
    });
  });
});
