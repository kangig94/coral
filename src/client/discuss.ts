/**
 * Public client adapter for discuss types and builders.
 *
 * The canonical definitions live in `src/discuss/views.ts`. This module
 * re-exports them so the `./client` public surface remains stable.
 */

export { buildDiscussDetail, buildDiscussSummary } from '../discuss/views.js';

export type {
  DiscussAuthority,
  DiscussAuditDetailResponse,
  DiscussAuditSessionDto,
  DiscussAuditTranscriptEntryDto,
  DiscussAuditView,
  DiscussControlBidsTranscriptEntryDto,
  DiscussControlDetailResponse,
  DiscussControlSessionDto,
  DiscussControlTranscriptEntryDto,
  DiscussControlView,
  DiscussDetailResponse,
  DiscussSummaryDto,
  DiscussView,
} from '../discuss/views.js';
