import type { ProcessIncarnation } from '../../infra/node-process.js';
import { providerProxySetAddress } from '../services/provider-proxy-set/identity.js';
import type { ProviderProxySetContainRequest } from '../../transport/rpc/catalog.js';
import type { ProviderProxySetBooleanOperatorExitResult } from '../services/provider-proxy-set/index.js';
import type { JobStore } from '../../jobs/store.js';
import { type createCoordinatorWorld } from './world.js';

type GuardianIdentity = Readonly<{ pid: number; incarnation: ProcessIncarnation }>;

export function createProviderProxyContainment({
  world,
  getProgressStore,
}: {
  world: ReturnType<typeof createCoordinatorWorld>;
  getProgressStore: () => JobStore;
}): {
  containProviderProxySet: (
    request: ProviderProxySetContainRequest,
    contract: 'current' | 'boolean',
    abandonWithoutAbsence: boolean,
    signal?: AbortSignal,
  ) => Promise<ProviderProxySetBooleanOperatorExitResult | Readonly<{ kind: 'unsupported-contract' }>>;
  closeProxySetForEpochClosure: (
    proxyInstanceId: string,
    guardian: GuardianIdentity,
    signal: AbortSignal,
  ) => Promise<boolean>;
} {
  const containProviderProxySet = async (
    request: ProviderProxySetContainRequest,
    contract: 'current' | 'boolean',
    abandonWithoutAbsence: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderProxySetBooleanOperatorExitResult | Readonly<{ kind: 'unsupported-contract' }>> => {
    const lifecycle = world.providerProxyLifecycleRef.get();
    if (lifecycle === null) throw new Error('provider_proxy_set_operator_exit_unavailable');
    const authorization =
      contract === 'boolean'
        ? lifecycle.authorizeBooleanOperatorExit(request.setIdentity)
        : lifecycle.authorizeOperatorExit(request.setIdentity);
    if (authorization.kind === 'unsupported-contract') return authorization;
    if (authorization.kind !== 'authorized') {
      if (contract === 'current' && authorization.kind === 'set-not-found' && abandonWithoutAbsence) {
        const abandonment = lifecycle.abandonDurableAcquisition(request.setIdentity);
        if (abandonment.kind === 'retired') {
          return {
            kind: 'representation-release-abandoned',
            setIdentity: request.setIdentity,
            successor: { owner: 'coordinator', acceptance: 'accepted' },
            effect: {
              signalsSent: [],
              containmentAbsent: false,
              representationAction: 'fatal-release-abandoned',
            },
          };
        }
        if (abandonment.kind === 'held') {
          return {
            kind: 'store-unreadable',
            setIdentity: request.setIdentity,
            effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
          };
        }
        if (abandonment.kind === 'transfer-pending') {
          return {
            kind: 'containment-unconfirmed',
            setIdentity: request.setIdentity,
            recoveryAction: { kind: 'retry-exact-set-containment' },
            effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
          };
        }
      }
      return {
        ...authorization,
        setIdentity: request.setIdentity,
        effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
      };
    }
    try {
      const proof = await world.providerProxySetContainmentProver.collectContainmentProof(
        authorization.capability.containmentProofAuthorization,
        getProgressStore().getDb(),
        signal ?? new AbortController().signal,
      );
      return contract === 'boolean'
        ? await lifecycle.completeBooleanOperatorExit(authorization.capability, proof, abandonWithoutAbsence, signal)
        : await lifecycle.completeOperatorExit(authorization.capability, proof, abandonWithoutAbsence, signal);
    } finally {
      try {
        authorization.capability.handback();
      } catch {
        authorization.capability.handback();
      }
    }
  };

  const closeProxySetForEpochClosure = async (
    proxyInstanceId: string,
    guardian: Readonly<{ pid: number; incarnation: ProcessIncarnation }>,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const set = world.providerProxyLifecycleRef
      .get()
      ?.liveSets()
      .find(
        (candidate) =>
          candidate.setIdentity.proxyInstanceId === proxyInstanceId &&
          candidate.setIdentity.guardianPid === guardian.pid &&
          candidate.setIdentity.guardianIncarnation === guardian.incarnation,
      );
    if (set === undefined) return false;
    const result = await containProviderProxySet(
      { setIdentity: providerProxySetAddress(set.setIdentity), mode: 'contain' },
      'current',
      false,
      signal,
    );
    return 'effect' in result && result.effect.containmentAbsent;
  };

  return { containProviderProxySet, closeProxySetForEpochClosure };
}
