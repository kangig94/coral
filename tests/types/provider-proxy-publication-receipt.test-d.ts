import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';

declare const structurallyMatchingReceipt: Readonly<{
  kind: 'provider-proxy-set-published';
}>;

// @ts-expect-error publication completion, not a structurally matching object, mints the receipt capability.
const publicationReceipt: PublicationReceipt = structurallyMatchingReceipt;

void publicationReceipt;
