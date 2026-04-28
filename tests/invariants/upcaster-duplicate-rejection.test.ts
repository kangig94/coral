// Invariant #15: per-type upcaster chain rejects duplicate registrations at
// the same fromVersion.
//
// Pins the structural guarantee that `UpcasterRegistry.registerUpcaster`
// throws `CoralSetupError(upcaster_conflict)` when the same `(type,
// fromVersion)` pair is registered twice, preventing silent override of an
// upcaster step that would corrupt replay semantics. The registry MAY accept
// multiple registrations for the same type at different fromVersions
// (the chain is keyed by `${type}|${fromVersion}`).

import { describe, expect, it } from 'vitest';

import { CoralSetupError } from '#src/runtime/errors.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';

describe('Invariant #15 — upcaster duplicate registration rejected', () => {
  it('throws CoralSetupError(upcaster_conflict) on second registration at same fromVersion', () => {
    const registry = createDefaultUpcasterRegistry();
    registry.registerUpcaster('test.event', 1, 2, (body) => body);

    let thrown: unknown;
    try {
      registry.registerUpcaster('test.event', 1, 2, (body) => body);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).code).toBe('upcaster_conflict');
  });

  it('rejects duplicate even when toVersion differs (key is type+fromVersion)', () => {
    const registry = createDefaultUpcasterRegistry();
    registry.registerUpcaster('test.event', 1, 2, (body) => body);

    let thrown: unknown;
    try {
      registry.registerUpcaster('test.event', 1, 3, (body) => body);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).code).toBe('upcaster_conflict');
  });

  it('accepts multiple registrations for the same type at different fromVersions', () => {
    const registry = createDefaultUpcasterRegistry();
    expect(() => {
      registry.registerUpcaster('test.event', 1, 2, (body) => body);
      registry.registerUpcaster('test.event', 2, 3, (body) => body);
      registry.registerUpcaster('test.event', 3, 4, (body) => body);
    }).not.toThrow();
  });

  it('accepts the same fromVersion across distinct type names', () => {
    const registry = createDefaultUpcasterRegistry();
    expect(() => {
      registry.registerUpcaster('test.alpha', 1, 2, (body) => body);
      registry.registerUpcaster('test.beta', 1, 2, (body) => body);
    }).not.toThrow();
  });
});
