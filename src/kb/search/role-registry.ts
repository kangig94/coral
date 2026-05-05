import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Disposable } from '../../runtime/ports.js';
import {
  retrievalRoleDescriptorSchema,
  type RegisteredRetrievalRole,
  type RetrievalRole,
  type RetrievalRoleDescriptor,
  type RoleCatalogView,
  type RoleExecutionRegistryView,
  type RoleHandle,
  type RoleRegistry,
} from './contract.js';

function freezeArray<T>(values: readonly T[]): T[] {
  return Object.freeze([...values]) as T[];
}

function canonicalSetOrder<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const unique: T[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return Object.freeze(unique.sort((left, right) => left.localeCompare(right))) as T[];
}

export function normalizeRetrievalRoleDescriptor(descriptor: RetrievalRoleDescriptor): RetrievalRoleDescriptor {
  const parsed = retrievalRoleDescriptorSchema.parse(descriptor);
  return Object.freeze({
    id: parsed.id,
    label: parsed.label,
    tags: freezeArray(parsed.tags),
    phase: parsed.phase,
    supportsScopes: canonicalSetOrder(parsed.supportsScopes),
    requires: canonicalSetOrder(parsed.requires ?? []),
    provides: parsed.provides,
  });
}

function freezeRecord(record: RegisteredRetrievalRole): RegisteredRetrievalRole {
  return Object.freeze(record);
}

function decorateScopeDispose(scope: Disposable, onDispose: () => void): void {
  const dispose = scope[Symbol.dispose].bind(scope);
  let disposed = false;
  scope[Symbol.dispose] = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    onDispose();
    dispose();
  };
}

export function createRoleRegistry(): RoleRegistry {
  const records = new Map<string, RegisteredRetrievalRole>();
  let listCache: readonly RegisteredRetrievalRole[] | null = null;
  let descriptorListCache: readonly RetrievalRoleDescriptor[] | null = null;

  const invalidateViews = (): void => {
    listCache = null;
    descriptorListCache = null;
  };

  const list = (): readonly RegisteredRetrievalRole[] => {
    listCache ??= Object.freeze([...records.values()]);
    return listCache;
  };

  const unregister = (id: string): boolean => {
    const deleted = records.delete(id);
    if (deleted) {
      invalidateViews();
    }
    return deleted;
  };

  const createHandle = (id: string): RoleHandle => {
    let disposed = false;
    return Object.freeze({
      id,
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        unregister(id);
      },
    });
  };

  const register = (
    role: RetrievalRole,
    origin: RegisteredRetrievalRole['origin'],
    permanence: RegisteredRetrievalRole['permanence'],
    options: { readonly criticality?: 'core' } = {},
  ): RoleHandle => {
    if (records.has(role.id)) {
      throw documentedCoralSetupError('role_id_occupied', { roleId: role.id });
    }

    const descriptor = normalizeRetrievalRoleDescriptor(role.descriptor);
    const record = freezeRecord({
      role,
      descriptor,
      origin,
      permanence,
      ...(options.criticality === undefined ? {} : { criticality: options.criticality }),
    });

    records.set(role.id, record);
    invalidateViews();
    return createHandle(role.id);
  };

  const executionView: RoleExecutionRegistryView = Object.freeze({
    list,
  });

  const catalogView: RoleCatalogView = Object.freeze({
    listDescriptors: () => {
      if (descriptorListCache !== null) {
        return descriptorListCache;
      }
      const descriptors: RetrievalRoleDescriptor[] = [];
      for (const record of records.values()) {
        descriptors.push(record.descriptor);
      }
      descriptorListCache = Object.freeze(descriptors);
      return descriptorListCache;
    },
  });

  return {
    registerScoped(role, scope) {
      const handle = register(role, 'external', 'scoped');
      decorateScopeDispose(scope, () => {
        handle.dispose();
      });
      return handle;
    },
    registerBuiltin(role, options) {
      return register(role, 'builtin', 'runtime', options);
    },
    unregister,
    list,
    executionView() {
      return executionView;
    },
    catalogView() {
      return catalogView;
    },
  };
}
