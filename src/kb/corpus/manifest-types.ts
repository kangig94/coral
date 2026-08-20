export type ManifestAuthorityLane = 'content' | 'metadata';

export type ManifestAuthorityDelta = {
  lane: ManifestAuthorityLane;
  manifestId: string;
  surfaceHash: string | null;
};
