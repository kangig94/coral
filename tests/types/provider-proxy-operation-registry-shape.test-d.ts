import type { ProviderProxyOperationSnapshot } from '../../src/coordinator/services/operation-registry.js';
import type {
  CreateProviderProxySetInheritanceOptions,
  ProviderProxySetInheritanceDeps,
} from '../../src/coordinator/services/provider-proxy-set/inheritance.js';

declare const operationsOnly: { operationsFor: () => never[] };
declare const fullSnapshot: { operationsFor: () => never[]; providerRootsFor: () => never[] };

// @ts-expect-error `providerRootsFor` is required on the shared snapshot type: an empty claim silently
// disagrees with any enforcer that has actually staged a root, so no caller may omit it.
const snapshotMissingProviderRoots: ProviderProxyOperationSnapshot = operationsOnly;
void snapshotMissingProviderRoots;

const snapshotWithProviderRoots: ProviderProxyOperationSnapshot = fullSnapshot;
void snapshotWithProviderRoots;

// @ts-expect-error the inheritance path's own dependency contract requires the same capability — this is
// the exact hole `?? []` used to paper over.
const inheritanceDepsRegistry: ProviderProxySetInheritanceDeps['operationRegistry'] = operationsOnly;
void inheritanceDepsRegistry;

const inheritanceDepsRegistryFull: ProviderProxySetInheritanceDeps['operationRegistry'] = fullSnapshot;
void inheritanceDepsRegistryFull;

// @ts-expect-error same requirement on the composition-time options `createProviderProxySetInheritance` takes.
const createOptionsRegistry: CreateProviderProxySetInheritanceOptions['operationRegistry'] = operationsOnly;
void createOptionsRegistry;

const createOptionsRegistryFull: CreateProviderProxySetInheritanceOptions['operationRegistry'] = fullSnapshot;
void createOptionsRegistryFull;
