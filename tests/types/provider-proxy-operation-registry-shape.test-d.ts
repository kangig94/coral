import type { ProviderProxyOperationSnapshot } from '../../src/coordinator/services/operation-registry.js';
import type {
  CreateProviderProxySetInheritanceOptions,
  ProviderProxySetInheritanceDeps,
} from '../../src/coordinator/services/provider-proxy-set-inheritance.js';

// Exactly the narrower shape `provider-proxy-set-inheritance.ts` used to declare before its forbidden-file
// constraint lifted: `adopt` and `operationsFor`, but no `providerRootsFor`.
declare const adoptAndOperationsOnly: { adopt: () => void; operationsFor: () => never[] };
declare const fullRegistry: { adopt: () => void; operationsFor: () => never[]; providerRootsFor: () => never[] };

// @ts-expect-error `providerRootsFor` is required on the shared snapshot type: an empty claim silently
// disagrees with any enforcer that has actually staged a root, so no caller may omit it.
const snapshotMissingProviderRoots: ProviderProxyOperationSnapshot = adoptAndOperationsOnly;
void snapshotMissingProviderRoots;

const snapshotWithProviderRoots: ProviderProxyOperationSnapshot = fullRegistry;
void snapshotWithProviderRoots;

// @ts-expect-error the inheritance path's own dependency contract requires the same capability — this is
// the exact hole `?? []` used to paper over.
const inheritanceDepsRegistry: ProviderProxySetInheritanceDeps['operationRegistry'] = adoptAndOperationsOnly;
void inheritanceDepsRegistry;

const inheritanceDepsRegistryFull: ProviderProxySetInheritanceDeps['operationRegistry'] = fullRegistry;
void inheritanceDepsRegistryFull;

// @ts-expect-error same requirement on the composition-time options `createProviderProxySetInheritance` takes.
const createOptionsRegistry: CreateProviderProxySetInheritanceOptions['operationRegistry'] = adoptAndOperationsOnly;
void createOptionsRegistry;

const createOptionsRegistryFull: CreateProviderProxySetInheritanceOptions['operationRegistry'] = fullRegistry;
void createOptionsRegistryFull;
