import type { ForeignTargetValidator } from '../../src/infra/handoff-target.js';
import type { Runtime } from '../../src/runtime/ports.js';
import type { ActiveStoreSelection } from '../../src/store/active-store-selection.js';
import {
  openOrResetBackendStoreDb,
  type BackendStoreResetAuthority,
  type OpenOrResetBackendStoreOptions,
} from '../../src/store/backend-store-reset.js';
import type { GenerationAdoptionLockLease } from '../../src/store/generation-mutation-coordination.js';
import type { ActiveStoreSelectionProtocolDependencies } from '../../src/store/active-store-selection-coordination.js';
import {
  discardStoreReset,
  type StoreResetDiscardDecision,
  type StoreResetDiscardOptions,
} from '../../src/store/operator-store-reset.js';
import {
  routeOrOpenBackendStoreAtStartup,
  type StartupActiveStoreSelectionOptions,
} from '../../src/store/startup-store-routing.js';

declare const runtime: Runtime;
declare const authority: BackendStoreResetAuthority;
declare const adoption: GenerationAdoptionLockLease;
declare const openOptions: OpenOrResetBackendStoreOptions;
declare const selection: ActiveStoreSelection;
declare const validator: ForeignTargetValidator;

openOrResetBackendStoreDb(runtime, authority, adoption, openOptions);

// @ts-expect-error reset-lock acquisition is unreachable without the nominal adoption lease.
openOrResetBackendStoreDb(runtime, authority, openOptions);

const startupOptions: StartupActiveStoreSelectionOptions = {
  storeFormat: openOptions.storeFormat,
  currentSelection: selection,
};

void routeOrOpenBackendStoreAtStartup({
  runtime,
  authority,
  options: startupOptions,
  validateForeignTarget: validator,
});

const forbiddenStartupOptions: StartupActiveStoreSelectionOptions = {
  storeFormat: openOptions.storeFormat,
  currentSelection: selection,
  // @ts-expect-error startup routing owns dependency composition, so its callers cannot supply dependencies.
  dependencies: {
    kind: 'operator',
    validateSelectedTarget: validator,
    resumeIncidentAsOperator: true,
  },
};

void forbiddenStartupOptions;

const forbiddenStartupDependencies: ActiveStoreSelectionProtocolDependencies = {
  kind: 'startup',
  validateSelectedTarget: validator,
  // @ts-expect-error a startup dependency literal cannot name operator-only recovery capabilities.
  acquireStoreRecoveryLease: async () => {
    throw new Error('type-only operator recovery lease');
  },
};

void forbiddenStartupDependencies;

declare const discardOptions: StoreResetDiscardOptions;

// @ts-expect-error callers must narrow the target before selecting the matching result contract.
discardStoreReset(discardOptions);

if (discardOptions.target === 'gen2') {
  const decision: Promise<StoreResetDiscardDecision> = discardStoreReset(discardOptions);
  void decision;
} else {
  const refusal: Promise<never> = discardStoreReset(discardOptions);
  void refusal;
}
