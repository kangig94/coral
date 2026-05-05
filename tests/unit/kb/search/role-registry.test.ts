import { describe, expect, it } from 'vitest';

import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import {
  retrievalRoleDescriptorSchema,
  type RetrievalRole,
  type RetrievalRoleDescriptor,
} from '#src/kb/search/contract.js';
import { createBuiltinTextRole } from '#src/kb/search/text-retrieval.js';
import { KB_EMBEDDING_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { Disposable } from '#src/runtime/ports.js';

function createScope(): Disposable {
  return {
    [Symbol.dispose]() {
      return;
    },
  };
}

function descriptor(id: string): RetrievalRoleDescriptor {
  return {
    id,
    label: `Role ${id}`,
    tags: ['semantic', 'lexical'],
    phase: 'retrieval-source',
    supportsScopes: ['sources', 'notes', 'all'],
    requires: [KB_VECTOR_CAPABILITY, KB_EMBEDDING_CAPABILITY],
    provides: 'retrieval-source',
  };
}

function role(id: string): RetrievalRole {
  const roleDescriptor = descriptor(id);
  return {
    id,
    descriptor: roleDescriptor,
    async search() {
      return { hits: [] };
    },
  };
}

function firstRecord(registry: ReturnType<typeof createRoleRegistry>) {
  const record = registry.list()[0];
  if (record === undefined) {
    throw new Error('expected registered role');
  }
  return record;
}

function expectRoleIdOccupied(action: () => void): void {
  try {
    action();
    throw new Error('expected duplicate role registration to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(CoralSetupError);
    expect(error).toMatchObject({ code: 'role_id_occupied' });
  }
}

describe('role registry runtime invariants', () => {
  it('freezes normalized descriptor objects and array fields after scoped registration', () => {
    const registry = createRoleRegistry();
    registry.registerScoped(role('scoped'), createScope());
    const record = firstRecord(registry);

    expect(Object.isFrozen(record.descriptor)).toBe(true);
    expect(Object.isFrozen(record.descriptor.tags)).toBe(true);
    expect(Object.isFrozen(record.descriptor.supportsScopes)).toBe(true);
    expect(Object.isFrozen(record.descriptor.requires)).toBe(true);
    expect(() => {
      record.descriptor.tags.push('x');
    }).toThrow(TypeError);
  });

  it('freezes normalized descriptor objects and array fields after builtin registration', () => {
    const registry = createRoleRegistry();
    registry.registerBuiltin(role('builtin'));
    const record = firstRecord(registry);

    expect(Object.isFrozen(record.descriptor)).toBe(true);
    expect(Object.isFrozen(record.descriptor.tags)).toBe(true);
    expect(Object.isFrozen(record.descriptor.supportsScopes)).toBe(true);
    expect(Object.isFrozen(record.descriptor.requires)).toBe(true);
  });

  it('accepts wiki as a retrieval role descriptor scope', () => {
    expect(
      retrievalRoleDescriptorSchema.parse({
        ...descriptor('wiki-descriptor'),
        supportsScopes: ['wiki'],
      }).supportsScopes,
    ).toEqual(['wiki']);
  });

  it('registers the builtin text descriptor with wiki scope support', () => {
    const registry = createRoleRegistry();
    registry.registerBuiltin(createBuiltinTextRole({} as KbRuntime), { criticality: 'core' });

    expect(firstRecord(registry).descriptor.supportsScopes).toContain('wiki');
  });

  it('rejects duplicate scoped role ids', () => {
    const registry = createRoleRegistry();
    const target = role('occupied');
    registry.registerScoped(target, createScope());

    expectRoleIdOccupied(() => registry.registerScoped(target, createScope()));
  });

  it('rejects duplicate builtin role ids', () => {
    const registry = createRoleRegistry();
    const target = role('occupied');
    registry.registerBuiltin(target);

    expectRoleIdOccupied(() => registry.registerBuiltin(target));
  });

  it('makes role handle disposal idempotent', () => {
    const registry = createRoleRegistry();
    const handle = registry.registerBuiltin(role('temporary'));

    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
    expect(registry.list()).toEqual([]);
  });

  it('frees scoped ids for re-registration when the scope is disposed', () => {
    const registry = createRoleRegistry();
    const scope = createScope();

    registry.registerScoped(role('reusable'), scope);
    scope[Symbol.dispose]();
    expect(() => registry.registerScoped(role('reusable'), createScope())).not.toThrow();
    expect(registry.list().map((record) => record.descriptor.id)).toEqual(['reusable']);
  });

  it('returns frozen read-only execution and catalog views', () => {
    const registry = createRoleRegistry();
    const executionView = registry.executionView();
    const catalogView = registry.catalogView();

    expect(Object.isFrozen(executionView)).toBe(true);
    expect(Object.isFrozen(catalogView)).toBe(true);
    expect('registerBuiltin' in executionView).toBe(false);
    expect('registerScoped' in executionView).toBe(false);
    expect('unregister' in executionView).toBe(false);
    expect('registerBuiltin' in catalogView).toBe(false);
    expect('registerScoped' in catalogView).toBe(false);
    expect('unregister' in catalogView).toBe(false);
  });

  it('preserves insertion order across multiple registrations', () => {
    const registry = createRoleRegistry();

    registry.registerBuiltin(role('first'));
    registry.registerScoped(role('second'), createScope());
    registry.registerBuiltin(role('third'));

    expect(registry.list().map((record) => record.descriptor.id)).toEqual(['first', 'second', 'third']);
  });

  it('keeps cached registry views fresh across mutations', () => {
    const registry = createRoleRegistry();
    const catalogView = registry.catalogView();

    const firstHandle = registry.registerBuiltin(role('first'));
    const firstList = registry.list();
    const firstDescriptors = catalogView.listDescriptors();

    expect(registry.list()).toBe(firstList);
    expect(catalogView.listDescriptors()).toBe(firstDescriptors);

    registry.registerBuiltin(role('second'));
    const secondList = registry.list();
    const secondDescriptors = catalogView.listDescriptors();

    expect(secondList).not.toBe(firstList);
    expect(secondList.map((record) => record.descriptor.id)).toEqual(['first', 'second']);
    expect(secondDescriptors).not.toBe(firstDescriptors);
    expect(secondDescriptors.map((descriptor) => descriptor.id)).toEqual(['first', 'second']);

    firstHandle.dispose();

    expect(registry.list()).not.toBe(secondList);
    expect(registry.list().map((record) => record.descriptor.id)).toEqual(['second']);
    expect(catalogView.listDescriptors()).not.toBe(secondDescriptors);
    expect(catalogView.listDescriptors().map((descriptor) => descriptor.id)).toEqual(['second']);
  });
});
