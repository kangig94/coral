import { backendLog } from '../../infra/backend-log.js';
import type { Disposable } from '../../runtime/ports.js';
import type { ConsumerHandle } from '../../store/consumer-contract.js';
import type { EngineArtifactDescriptor, EngineArtifactPort } from './artifact-port.js';

export interface EngineArtifactRegistration {
  unregister(): void;
}

export interface EngineArtifactRegistrationOptions {
  readonly targetConsumerHandles: readonly ConsumerHandle[];
}

type RegistryEntry = {
  readonly id: number;
  readonly port: EngineArtifactPort;
  readonly targetConsumerIds: readonly string[];
  readonly scope: Disposable;
};

export class EngineArtifactRegistry {
  private nextId = 1;
  private readonly entries = new Map<number, RegistryEntry>();

  register(
    port: EngineArtifactPort,
    options: EngineArtifactRegistrationOptions,
    scope: Disposable,
  ): EngineArtifactRegistration {
    const id = this.nextId;
    this.nextId += 1;
    const entry: RegistryEntry = {
      id,
      port,
      targetConsumerIds: [...new Set(options.targetConsumerHandles.map((handle) => handle.id))],
      scope,
    };
    this.entries.set(id, entry);

    let unregistered = false;
    return {
      unregister: () => {
        if (unregistered) {
          return;
        }
        unregistered = true;
        this.entries.delete(id);
      },
    };
  }

  unregisterScope(scope: Disposable): void {
    for (const entry of this.entries.values()) {
      if (entry.scope === scope) {
        this.entries.delete(entry.id);
      }
    }
  }

  async describeArtifacts(): Promise<readonly EngineArtifactDescriptor[]> {
    const descriptors: EngineArtifactDescriptor[] = [];
    for (const entry of this.entries.values()) {
      let described: readonly EngineArtifactDescriptor[];
      try {
        described = await entry.port.describeArtifacts();
      } catch (error: unknown) {
        // Per-port fault isolation: a single engine's artifact port must not
        // abort boot artifact repair or rescan info collection for the rest
        // of the registry. Log the failure and continue with the remaining
        // entries' descriptors.
        const message = error instanceof Error ? error.message : String(error);
        backendLog.warn(`EngineArtifactRegistry: port for consumers [${entry.targetConsumerIds.join(', ')}] threw during describeArtifacts(): ${message}`);
        continue;
      }
      for (const descriptor of described) {
        descriptors.push({
          ...descriptor,
          targetConsumerIds: entry.targetConsumerIds,
        });
      }
    }
    return descriptors;
  }
}
