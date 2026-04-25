import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('Runtime.paths.coral lazy getter seal', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws CoralSetupError(E_FLAVOR_NOT_SETTLED) when accessed before setBuildFlavor', async () => {
    const { createRealRuntime } = await import('#src/runtime/real.js');
    const { CoralSetupError } = await import('#src/runtime/errors.js');
    const rt = createRealRuntime();

    let thrown: unknown;
    try {
      void rt.paths.coral;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect(thrown).toMatchObject({ code: 'E_FLAVOR_NOT_SETTLED' });
  });

  it('returns frozen CoralPaths after setBuildFlavor(dev) and caches the result', async () => {
    const paths = await import('#src/infra/build-flavor.js');
    paths.setBuildFlavor('dev');
    const { createRealRuntime } = await import('#src/runtime/real.js');
    const rt = createRealRuntime();

    const first = rt.paths.coral;
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.store.dbDir).toContain('data-dev/store');

    const second = rt.paths.coral;
    expect(second).toBe(first);
  });

  it('returns frozen CoralPaths after setBuildFlavor(prod)', async () => {
    const paths = await import('#src/infra/build-flavor.js');
    paths.setBuildFlavor('prod');
    const { createRealRuntime } = await import('#src/runtime/real.js');
    const rt = createRealRuntime();

    const first = rt.paths.coral;
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.store.dbDir).toContain('data/store');
    expect(first.store.dbDir).not.toContain('data-dev');
  });
});
