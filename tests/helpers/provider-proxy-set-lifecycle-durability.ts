import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StoragePort, TimePort } from '#src/infra/port-types.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import type { ProviderProxySetLifecycleDeps } from '#src/coordinator/services/provider-proxy-set/index.js';

export function testProviderProxySetLifecycleDurability(
  storage: StoragePort,
  _time: Pick<TimePort, 'now' | 'monotonicNow' | 'setTimeout' | 'clearTimeout'>,
): Pick<
  ProviderProxySetLifecycleDeps,
  | 'operatorDispositionStore'
  | 'writerIncarnation'
  | 'collectOperatorDispositionContainmentProof'
  | 'reobserveAcquisitionContainment'
> {
  return {
    operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(
      storage,
      join(tmpdir(), 'coral-provider-proxy-set-dispositions', randomUUID()),
    ),
    writerIncarnation: randomUUID(),
    collectOperatorDispositionContainmentProof: async () => {
      throw new Error('test fixture unexpectedly requested durable set re-observation');
    },
    reobserveAcquisitionContainment: async () => ({
      kind: 'held',
      observation: 'unknown',
      reason: 'test fixture cannot observe durable acquisition containment',
    }),
  };
}
