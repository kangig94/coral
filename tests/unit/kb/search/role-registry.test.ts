import { describe, expect, it } from 'vitest';

import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import { type RetrievalRole, type RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
import { KB_EMBEDDING_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
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
});
