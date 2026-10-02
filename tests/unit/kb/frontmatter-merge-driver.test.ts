import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeFrontmatter } from '#src/kb/corpus/frontmatter.js';
import {
  FrontmatterMergeUnavailableError,
  runFrontmatterMergeDriver,
  type FrontmatterMergeDriverHost,
} from '#src/kb/curate/frontmatter-merge-driver.js';
import type { KbNoteFrontmatter } from '#src/kb/entry-types.js';

const SEED_META: KbNoteFrontmatter = {
  tags: ['seed'],
  principles: [],
  source: ['kangig94/coral'],
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
};

function renderNote(meta: KbNoteFrontmatter, body: string): string {
  return `${serializeFrontmatter(meta)}# Merge Note\n\n${body.trim()}\n`;
}

function createFrontmatterMergeHost(
  root: string,
  observed?: { options: { stdio: 'ignore'; timeout: number } | null },
): FrontmatterMergeDriverHost {
  return {
    readFileSync,
    writeFileSync,
    createTempDir: (prefix) => mkdtempSync(join(root, prefix)),
    rmSync,
    execFileSync: (command, args, options) => {
      if (observed) observed.options = options;
      return execFileSync(command, args, options);
    },
  };
}

describe('frontmatter merge driver', () => {
  let root: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coral-frontmatter-driver-'));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
  });

  // The git-facing half, and the highest-consequence property in this file. Git reads a merge driver's exit
  // code as zero = merged cleanly, non-zero = conflict — nothing else. So a refusal that exits 0 tells git the
  // file is merged while `%A` still holds the pre-merge body and the incoming revision is silently gone: the
  // same loss as writing the unmerged body, reached through the exit code instead of the write.
  //
  // Nothing at this command enforces that. It holds only because `buildErrorEnvelope` has no branch returning
  // 0, which is a property of the error registry rather than a decision made here — so it is asserted here,
  // where breaking it costs a user their edit.

  // The host type requires a `timeout`, which is what makes the invariant's exemption of the forwarding
  // adapter true — but a required field is satisfied by `0`, and `execFileSync` reads `0` as no bound. The
  // type check and the AST scan both pass on that; only an assertion on the value does not.

  // `oursPath` is git's `%A` — the user's working-tree file, not a temp copy — and the driver writes it at the
  // end of every successful run. So the only thing standing between a `git merge-file` that never answered and
  // a silently truncated file is that this path refuses to reach the write at all.
  //
  // The previous test on this bound asserted only that the timeout was a positive number. That is the check
  // that passes while the failure it exists for is unhandled.

  // The reachable half, with real git and no timeout involved. A KB note holding a NUL byte makes
  // `git merge-file` exit 255 having written nothing — no merge, and no conflict markers either. Under a
  // `status > 0` predicate that arrived as "255 conflicts", the driver wrote the *unmerged* body over the
  // user's file and told git the merge conflicted; the next `git add` made it permanent. This is why the
  // upper bound belongs to the same fix as the timeout refusal rather than beside it.
  it('refuses when real git rejects a binary input, rather than reading 255 as a conflict count', () => {
    const meta = SEED_META;
    const oursPath = join(root, 'binary-note.md');
    const basePath = join(root, 'binary-base.md');
    const theirsPath = join(root, 'binary-theirs.md');
    const original = renderNote(meta, 'the body the user still has');
    writeFileSync(oursPath, original, 'utf-8');
    writeFileSync(basePath, renderNote(meta, 'base body'), 'utf-8');
    writeFileSync(theirsPath, renderNote(meta, 'incoming\u0000body'), 'utf-8');

    expect(() =>
      runFrontmatterMergeDriver(
        { basePath, oursPath, theirsPath, filePath: 'notes/binary-note.md' },
        createFrontmatterMergeHost(root),
      ),
    ).toThrow(FrontmatterMergeUnavailableError);

    expect(readFileSync(oursPath, 'utf-8'), 'the working-tree file is what the user had').toBe(original);
  });
});
