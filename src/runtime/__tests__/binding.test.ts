import { describe, expect, it } from 'vitest';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { Disposable } from '#src/runtime/ports.js';

describe('createRuntimeBinding', () => {
  it('binds and reads the bound value', () => {
    const binding = createRuntimeBinding('orama');
    binding.binding = 'kb.vector';
    binding.bind('needle', { [Symbol.dispose]() {} }, 'needle');
    expect(binding.read()).toBe('needle');
  });

  it('throws binding-occupied with heldBy on double bind', () => {
    const binding = createRuntimeBinding('orama');
    binding.binding = 'kb.vector';
    binding.bind('needle', { [Symbol.dispose]() {} }, 'needle');
    let thrown: unknown;
    try {
      binding.bind('other', { [Symbol.dispose]() {} }, 'other');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError & { heldBy: string }).code).toBe('binding-occupied');
    expect((thrown as CoralSetupError & { heldBy: string }).heldBy).toBe('needle');
  });

  it('returns the default again after scope disposal', () => {
    const binding = createRuntimeBinding('orama');
    binding.binding = 'kb.vector';
    let disposeCalls = 0;
    const scope: Disposable = { [Symbol.dispose]: () => { disposeCalls += 1; } };
    binding.bind('needle', scope, 'needle');
    scope[Symbol.dispose]();
    expect(disposeCalls).toBe(1);
    expect(binding.heldBy).toBeUndefined();
    expect(binding.read()).toBe('orama');
  });

  it('throws binding-empty with the binding name when no default exists', () => {
    const binding = createRuntimeBinding<string>();
    binding.binding = 'kb.embedding';
    let thrown: unknown;
    try {
      binding.read();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError & { binding: string }).code).toBe('binding-empty');
    expect((thrown as CoralSetupError & { binding: string }).binding).toBe('kb.embedding');
  });

  it('supports using scopes as a disposal smoke test', () => {
    const binding = createRuntimeBinding('orama');
    binding.binding = 'kb.vector';
    let disposed = false;
    {
      using scope: Disposable = { [Symbol.dispose]: () => { disposed = true; } };
      binding.bind('needle', scope, 'needle');
      expect(binding.read()).toBe('needle');
    }
    expect(disposed).toBe(true);
    expect(binding.read()).toBe('orama');
  });
});
