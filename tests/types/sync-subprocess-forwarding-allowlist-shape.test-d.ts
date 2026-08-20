/**
 * `tsc -p tsconfig/typecheck.json` (via `npm run typecheck:tests`) is what would have caught it: vitest does
 * not typecheck, so a `@ts-expect-error` assertion wrapped in `expect()` inside a `.test.ts` file passes at
 * runtime regardless of whether the type actually requires `timeout` — only this file, run through `tsc`, can
 * hold that fact. Kept where CI runs it rather than only in a mutation somebody performed once and reverted.
 */

import type { FrontmatterMergeDriverHost } from '#src/kb/curate/frontmatter-merge-driver.js';

type Options = Parameters<FrontmatterMergeDriverHost['execFileSync']>[2];

// Sanity: the legitimate shape still resolves without error, so the rejection below is the type system
// refusing an unbounded call — not the options type being unusable in every direction.
const _bounded: Options = { stdio: 'ignore', timeout: 2_000 };
void _bounded;

// @ts-expect-error `timeout` is required; if this stops erroring, the allowlist entry has become false.
const _unbounded: Options = { stdio: 'ignore' };
void _unbounded;
