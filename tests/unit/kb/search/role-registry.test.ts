import { describe, expect, it } from 'vitest';

import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import type { RetrievalRole, RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
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
    requires: ['kb.vector', 'kb.embedding'],
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
      (record.descriptor.tags as string[]).push('x');
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
});
