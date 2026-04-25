// Standalone type declarations for the Corpus manifest-authority subsystem.
// Lives in its own file to break a `kb/contracts.ts ↔ manifest-authority.ts`
// import cycle: `kb/contracts.ts` references `ManifestAuthorityDelta` on the
// `KbRuntime` interface, while `manifest-authority.ts` references `KbRuntime`
// in its implementations. Both can import this file without forming a cycle.
export type ManifestAuthorityLane = 'content' | 'metadata';

export type ManifestAuthorityDelta = {
  lane: ManifestAuthorityLane;
  manifestId: string;
  surfaceHash: string | null;
};
