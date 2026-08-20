import type { AppServerTransport, HostRef, ProviderServerSpec } from '../contract.js';

export type ManagedHostSession = Readonly<{
  session: AppServerTransport;
  hostRef: HostRef;
  close(): void;
}>;

export type AppServerHostExpectation = Readonly<{
  spec: ProviderServerSpec;
  jobId: string;
}>;

export interface AppServerHostAuthority {
  openSession(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ManagedHostSession>;
  attachSession(hostRef: HostRef, expectation: AppServerHostExpectation): Promise<ManagedHostSession | null>;
}
