import type {
  HostRef,
  ProviderServerSpec,
  ProviderTurnContainment,
  ProviderTurnContainmentAcceptance,
} from '../contract.js';

export type ManagedHostSession = ProviderTurnContainment['lease'];

export type AppServerHostExpectation = Readonly<{
  spec: ProviderServerSpec;
  jobId: string;
}>;

export interface AppServerHostAuthority {
  acceptTurnContainment?(obligation: ProviderTurnContainment): ProviderTurnContainmentAcceptance;
  openSession(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ManagedHostSession>;
  attachSession(hostRef: HostRef, expectation: AppServerHostExpectation): Promise<ManagedHostSession | null>;
}
