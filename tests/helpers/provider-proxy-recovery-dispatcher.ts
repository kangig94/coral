import {
  createProviderProxyRecoveryDispatcher,
  providerProxyRecoveryRoleControlPort,
  type ProviderProxyRecoveryProducerPorts,
  type ProviderProxySetLifecycleFatalError,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';

const unconfigured = (producer: string): never => {
  throw new Error(`Test provider proxy recovery producer '${producer}' is not configured.`);
};

export function createTestProviderProxyRecoveryDispatcher(
  producers: Partial<ProviderProxyRecoveryProducerPorts>,
  onFatal: (error: ProviderProxySetLifecycleFatalError) => void = () => undefined,
) {
  return createProviderProxyRecoveryDispatcher({
    producers: {
      'disappearance-terminalization':
        producers['disappearance-terminalization'] ?? (() => unconfigured('disappearance-terminalization')),
      'role-control': producers['role-control'] ?? providerProxyRecoveryRoleControlPort,
      'set-inheritance': producers['set-inheritance'] ?? (() => unconfigured('set-inheritance')),
      'capsule-redemption': producers['capsule-redemption'] ?? (() => unconfigured('capsule-redemption')),
      'containment-proof': producers['containment-proof'] ?? (() => unconfigured('containment-proof')),
      'capsule-retirement': producers['capsule-retirement'] ?? (() => unconfigured('capsule-retirement')),
      'disappearance-consumer': producers['disappearance-consumer'] ?? (() => unconfigured('disappearance-consumer')),
    },
    fatalSink: { fatal: onFatal },
  });
}
