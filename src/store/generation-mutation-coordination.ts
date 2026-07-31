import type { Runtime } from '../runtime/ports.js';

export type GenerationMutationKind = 'install' | 'update' | 'uninstall';

export interface GenerationReadinessCompletion {
  release(): void;
}

export interface GenerationWriterLease {
  assertOwned(): void;
  release(): void;
}

export interface GenerationMutationCoordination {
  completeReadiness(
    runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage' | 'time'>,
    mutation: { readonly kind: GenerationMutationKind; readonly name: string },
  ): Promise<GenerationReadinessCompletion>;
  acquireWriterLease(
    runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage' | 'time'>,
    mutation: { readonly kind: GenerationMutationKind; readonly name: string },
  ): Promise<GenerationWriterLease>;
}

export const generationMutationCoordinationSeam: GenerationMutationCoordination = {
  async completeReadiness() {
    return { release() {} };
  },
  async acquireWriterLease() {
    let owned = true;
    return {
      assertOwned() {
        if (!owned) throw new Error('Generation writer lease is no longer owned.');
      },
      release() {
        owned = false;
      },
    };
  },
};

export async function acquireGenerationWriterLeaseAfterReadiness(
  coordination: GenerationMutationCoordination,
  runtime: Pick<Runtime, 'flavor' | 'paths' | 'storage' | 'time'>,
  mutation: { readonly kind: GenerationMutationKind; readonly name: string },
): Promise<GenerationWriterLease> {
  const readiness = await coordination.completeReadiness(runtime, mutation);
  readiness.release();
  return coordination.acquireWriterLease(runtime, mutation);
}
