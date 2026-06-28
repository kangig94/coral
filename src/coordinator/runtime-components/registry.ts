import type { RuntimeComponent, RuntimeComponentId, RuntimeComponentStatus } from './contract.js';

export interface RuntimeComponentRegistry {
  register(component: RuntimeComponent): void;
  /** Fire-and-forget Era III. Each component runs its own internal retry. */
  initAll(signal: AbortSignal): void;
  disposeAll(signal: AbortSignal): Promise<void>;
  list(): readonly RuntimeComponentStatus[];
  status(id: RuntimeComponentId): RuntimeComponentStatus | null;
}

export function createRuntimeComponentRegistry(): RuntimeComponentRegistry {
  const components = new Map<RuntimeComponentId, RuntimeComponent>();

  return {
    register(component) {
      if (components.has(component.id)) {
        throw new Error(`Runtime component ${component.id} already registered`);
      }
      components.set(component.id, component);
    },
    initAll(signal) {
      for (const component of components.values()) {
        // Per-component catch ensures one component's throw doesn't crash the registry.
        void component.init(signal).catch(() => {
          // Runtime component captures its own failure into status; registry stays silent.
        });
      }
    },
    async disposeAll(signal) {
      await Promise.all([...components.values()].map((component) => component.dispose(signal).catch(() => {})));
    },
    list() {
      return [...components.values()].map((component) => component.status);
    },
    status(id) {
      const component = components.get(id);
      return component ? component.status : null;
    },
  };
}
