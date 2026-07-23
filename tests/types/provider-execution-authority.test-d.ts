import type {
  ProviderAppServerImplementation,
  ProviderAppServerRuntime,
  ProviderStandaloneImplementation,
  ProviderStandaloneRuntime,
} from '../../src/providers/contract.js';
import type {
  BoundProviderAppServerExecutionRuntime,
  BoundProviderStandaloneExecutionRuntime,
} from '../../src/providers/bound-provider-contract.js';
import type { ProviderExecutionPlan } from '../../src/providers/execution-plan.js';

type TestPlan = ProviderExecutionPlan<undefined, undefined, undefined>;

declare const appServerRuntime: ProviderAppServerRuntime<TestPlan>;
void appServerRuntime.appServerSession;
// @ts-expect-error app-server execution never receives standalone CLI authority.
void appServerRuntime.runCli;

declare const standaloneRuntime: ProviderStandaloneRuntime<TestPlan>;
void standaloneRuntime.runCli;
// @ts-expect-error standalone execution never receives app-server session authority.
void standaloneRuntime.appServerSession;

declare const boundAppServerRuntime: BoundProviderAppServerExecutionRuntime;
// @ts-expect-error bound app-server execution cannot construct a CLI runner.
void boundAppServerRuntime.runCli;

declare const boundStandaloneRuntime: BoundProviderStandaloneExecutionRuntime;
void boundStandaloneRuntime.runCli;
// @ts-expect-error app-server sessions are assembled only inside the bound provider.
void boundStandaloneRuntime.appServerSession;

declare const appServerImplementation: ProviderAppServerImplementation<TestPlan>;
void appServerImplementation.appServer;
// @ts-expect-error app-server preparation cannot produce standalone CLI requests.
void appServerImplementation.prepareExecutionPlan({} as never).prepareCliRequest;

declare const standaloneImplementation: ProviderStandaloneImplementation<TestPlan>;
void standaloneImplementation.prepareExecutionPlan({} as never).prepareCliRequest;
// @ts-expect-error standalone implementations have no app-server lifecycle authority.
void standaloneImplementation.appServer;
