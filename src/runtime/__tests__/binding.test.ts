import { describe, expect, it } from 'vitest';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import type { Disposable } from '#src/runtime/ports.js';

describe('createRuntimeBinding', () => {
  it('binds and reads the bound value', () => {
    const binding = createRuntimeBinding<string>('kb.vector', 'orama');
    binding.bind('needle', { [Symbol.dispose]() {} }, 'needle');
    expect(binding.read()).toBe('needle');
  });

  it('throws binding_occupied with heldBy on double bind', () => {
    const binding = createRuntimeBinding<string>('kb.vector', 'orama');
    binding.bind('needle', { [Symbol.dispose]() {} }, 'needle');
    let thrown: unknown;
    try {
      binding.bind('other', { [Symbol.dispose]() {} }, 'other');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect(thrown).toMatchObject({
      code: 'binding_occupied',
      context: { binding: 'kb.vector', heldBy: 'needle' },
    });
  });

  it('returns the default again after scope disposal', () => {
    const binding = createRuntimeBinding<string>('kb.vector', 'orama');
    let disposeCalls = 0;
    const scope: Disposable = { [Symbol.dispose]: () => { disposeCalls += 1; } };
    binding.bind('needle', scope, 'needle');
    scope[Symbol.dispose]();
    expect(disposeCalls).toBe(1);
    expect(binding.heldBy).toBeUndefined();
    expect(binding.read()).toBe('orama');
  });

  it('throws binding_empty with the binding name when no default exists', () => {
    const binding = createRuntimeBinding<string>('kb.embedding');
    let thrown: unknown;
    try {
      binding.read();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect(thrown).toMatchObject({
      code: 'binding_empty',
      context: { binding: 'kb.embedding' },
    });
  });
});
