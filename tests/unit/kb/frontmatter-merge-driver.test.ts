import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '#src/cli/program.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { extractBody, parseFrontmatter, serializeFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import {
  FRONTMATTER_SCALAR_TIEBREAK_RULE,
  FrontmatterMergeUnavailableError,
  mergeMarkdownRevisions,
  runFrontmatterMergeDriver,
  type FrontmatterMergeDriverHost,
} from '#src/kb/curate/frontmatter-merge-driver.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import type { KbNoteFrontmatter } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';

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

async function runCli(program: Command, args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  let stdout = '';
  let stderr = '';
  const originalArgv = [...process.argv];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write);

  try {
    process.exitCode = undefined;
    process.argv = ['node', 'coral-cli', ...args];
    await program.parseAsync(process.argv);
    return {
      stdout,
      stderr,
      status: process.exitCode ?? 0,
    };
  } finally {
    process.argv = originalArgv;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = undefined;
  }
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

  it('merges concurrent first-classification note frontmatter to sorted set unions with no conflict markers', () => {
    const body = 'Stable note body for both machines.';
    const inputFingerprint = computeBodySurfaceHash(body);
    const base = renderNote(
      {
        tags: ['seed'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      },
      body,
    );
    const ours = renderNote(
      {
        tags: ['seed', 'ours-tag'],
        principles: ['ours-principle'],
        source: ['kangig94/coral'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-16T00:00:00.000Z',
        inputFingerprint,
        related: ['note:ours-related'],
      },
      body,
    );
    const theirs = renderNote(
      {
        tags: ['theirs-tag', 'seed'],
        principles: ['theirs-principle'],
        source: ['kangig94/coral'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
        inputFingerprint,
        related: ['source:theirs-related'],
      },
      body,
    );

    const { content, result } = mergeMarkdownRevisions(
      base,
      ours,
      theirs,
      'notes/merge-note.md',
      createFrontmatterMergeHost(root),
    );
    const merged = parseFrontmatter(content);

    expect(result).toEqual({ status: 0, bodyConflict: false });
    expect(content).not.toContain('<<<<<<<');
    expect(merged.tags).toEqual(['ours-tag', 'seed', 'theirs-tag']);
    expect(merged.principles).toEqual(['ours-principle', 'theirs-principle']);
    expect(merged.related).toEqual(['note:ours-related', 'source:theirs-related']);
    expect(merged.updatedAt).toBe('2026-06-17T00:00:00.000Z');
    expect(merged.inputFingerprint).toBe(inputFingerprint);
    expect(extractBody(content)).toBe(body);
  });

  it('returns nonzero and preserves both sides with conflict markers for same-region note body edits', () => {
    const base = renderNote(
      {
        tags: ['seed'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
        inputFingerprint: computeBodySurfaceHash('The shared sentence.'),
      },
      'The shared sentence.',
    );
    const oursBody = 'The local machine rewrote this sentence.';
    const theirsBody = 'The remote machine rewrote this sentence.';
    const ours = renderNote(
      {
        tags: ['ours-tag'],
        principles: ['ours-principle'],
        source: ['kangig94/coral'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-16T00:00:00.000Z',
        inputFingerprint: computeBodySurfaceHash(oursBody),
      },
      oursBody,
    );
    const theirs = renderNote(
      {
        tags: ['theirs-tag'],
        principles: ['theirs-principle'],
        source: ['kangig94/coral'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
        inputFingerprint: computeBodySurfaceHash(theirsBody),
      },
      theirsBody,
    );

    const { content, result } = mergeMarkdownRevisions(
      base,
      ours,
      theirs,
      'notes/merge-note.md',
      createFrontmatterMergeHost(root),
    );

    expect(() => parseFrontmatter(content)).not.toThrow();
    const merged = parseFrontmatter(content);

    expect(result.bodyConflict).toBe(true);
    expect(result.status).toBeGreaterThan(0);
    expect(content).toContain('<<<<<<<');
    expect(content).toContain('=======');
    expect(content).toContain('>>>>>>>');
    expect(content).toContain(oursBody);
    expect(content).toContain(theirsBody);
    expect(merged.tags.length).toBeGreaterThan(0);
    expect(merged.tags).toEqual(['ours-tag', 'theirs-tag']);
    expect(merged.principles).toEqual(['ours-principle', 'theirs-principle']);
  });

  it('exposes the bundled CLI frontmatter merge-driver subcommand', async () => {
    const body = 'CLI merge body.';
    const inputFingerprint = computeBodySurfaceHash(body);
    const basePath = join(root, 'base.md');
    const oursPath = join(root, 'ours.md');
    const theirsPath = join(root, 'theirs.md');
    writeFileSync(
      basePath,
      renderNote(
        {
          tags: ['seed'],
          principles: [],
          source: ['kangig94/coral'],
          createdAt: '2026-06-15T00:00:00.000Z',
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
        body,
      ),
      'utf-8',
    );
    writeFileSync(
      oursPath,
      renderNote(
        {
          tags: ['ours-tag'],
          principles: ['ours-principle'],
          source: ['kangig94/coral'],
          createdAt: '2026-06-15T00:00:00.000Z',
          updatedAt: '2026-06-16T00:00:00.000Z',
          inputFingerprint,
        },
        body,
      ),
      'utf-8',
    );
    writeFileSync(
      theirsPath,
      renderNote(
        {
          tags: ['theirs-tag'],
          principles: ['theirs-principle'],
          source: ['kangig94/coral'],
          createdAt: '2026-06-15T00:00:00.000Z',
          updatedAt: '2026-06-17T00:00:00.000Z',
          inputFingerprint,
        },
        body,
      ),
      'utf-8',
    );

    const result = await runCli(buildProgram(), [
      'kb',
      'merge-frontmatter',
      basePath,
      oursPath,
      theirsPath,
      'notes/merge-note.md',
    ]);

    expect(result).toEqual({ stdout: '', stderr: '', status: 0 });
    expect(parseFrontmatter(readFileSync(oursPath, 'utf-8')).tags).toEqual(['ours-tag', 'theirs-tag']);
  });

  // The git-facing half, and the highest-consequence property in this file. Git reads a merge driver's exit
  // code as zero = merged cleanly, non-zero = conflict — nothing else. So a refusal that exits 0 tells git the
  // file is merged while `%A` still holds the pre-merge body and the incoming revision is silently gone: the
  // same loss as writing the unmerged body, reached through the exit code instead of the write.
  //
  // Nothing at this command enforces that. It holds only because `buildErrorEnvelope` has no branch returning
  // 0, which is a property of the error registry rather than a decision made here — so it is asserted here,
  // where breaking it costs a user their edit.
  it('exits non-zero when the driver refuses, because git reads zero as merged', async () => {
    const meta = SEED_META;
    const basePath = join(root, 'cli-refusal-base.md');
    const oursPath = join(root, 'cli-refusal-ours.md');
    const theirsPath = join(root, 'cli-refusal-theirs.md');
    const original = renderNote(meta, 'the body the user still has');
    writeFileSync(basePath, renderNote(meta, 'base body'), 'utf-8');
    writeFileSync(oursPath, original, 'utf-8');
    // Real git exits 255 on this and writes nothing — no merge, and no conflict markers either.
    writeFileSync(theirsPath, renderNote(meta, 'incoming\u0000body'), 'utf-8');

    const result = await runCli(buildProgram(), [
      'kb',
      'merge-frontmatter',
      basePath,
      oursPath,
      theirsPath,
      'notes/cli-refusal.md',
    ]);

    expect(result.status, 'zero here would tell git the merge succeeded').not.toBe(0);
    expect(result.stderr, 'and the refusal has to be readable, not just signalled').toMatch(/did not answer/u);
    // The state this leaves is the confusing one: git marks the path conflicted while the file carries no
    // conflict markers, so it looks resolved. A refusal that describes that state without naming an action is
    // what gets the file staged as-is.
    //
    // `git rebase --abort` is the command asserted here, not `git checkout --ours`/`--theirs`: reproduced
    // against real git 2.43, `--ours` during Coral's only automated path into this driver (`git rebase`) is
    // the *upstream* side, so a message telling an operator to run it to "keep their edit" discards that
    // edit instead. `git rebase --abort` is correct regardless of which side `%A` currently holds.
    expect(result.stderr, 'the operator is told what to do, not only what did not happen').toMatch(
      /git rebase --abort/u,
    );
    expect(result.stderr, 'never prescribes the command that discards the edit under rebase').not.toMatch(
      /checkout --ours/u,
    );
    expect(result.stderr, 'including why it must not simply be staged').toMatch(/no conflict markers/u);
    // A rebase touching several `.md` files invokes this driver once per file, and git does not prefix a
    // driver's stderr with the path it ran on — so a refusal that does not name the file is ambiguous about
    // which of several unresolved files it describes, and the recovery command has no target without it.
    expect(result.stderr, 'the refusal names which file failed to merge').toContain('notes/cli-refusal.md');
    expect(readFileSync(oursPath, 'utf-8'), 'the working-tree file is untouched').toBe(original);
  });

  it('registers the frontmatter merge driver alongside the entity-graph driver', () => {
    const pluginRoot = join(root, 'plugin root');
    // `resolvePluginRoot()` checks the esbuild-injected `__PLUGIN_ROOT__` global first, and `vitest/setup.ts`
    // pins that to this repo's own `clients/` for every test — unstubbed, the driver command below would be
    // built from the real bundle path regardless of what `envPort` returns, and the assertion further down
    // would pass either way.
    vi.stubGlobal('__PLUGIN_ROOT__', undefined);
    const runtime = createRealRuntime('prod');
    const gitCalls: string[][] = [];
    const execSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('git');
      gitCalls.push(args);
      return {
        stdout: args[0] === 'rev-parse' ? 'true\n' : '',
        stderr: '',
        status: 0,
      };
    });

    const controller = createGitSyncController({
      kb: {
        markdownRoot: root,
        time: runtime.time,
      } as unknown as KbRuntime,
      curateAssistant: { complete: async () => '' },
      processPort: {
        execSync,
        exec: vi.fn(),
      },
      storagePort: runtime.storage,
      envPort: {
        get: (key: string) => (key === 'CLAUDE_PLUGIN_ROOT' ? pluginRoot : undefined),
      },
    });

    controller.ensureKbMergeDrivers();

    const gitattributes = readFileSync(join(root, '.gitattributes'), 'utf-8');
    expect(gitattributes).toContain('.entity-graph.json merge=coral-entity-graph');
    expect(gitattributes).toContain('*.md merge=coral-frontmatter');
    expect(gitCalls).toContainEqual(['config', 'rebase.backend', 'merge']);
    const frontmatterDriverCall = gitCalls.find(
      (args) => args[0] === 'config' && args[1] === 'merge.coral-frontmatter.driver',
    );
    expect(frontmatterDriverCall?.[2]).toContain('kb merge-frontmatter "%O" "%A" "%B" "%P"');
    // Asserts `pluginRoot` itself, not just the `bridge/coral-cli.cjs` suffix every plugin root shares — that
    // weaker check would pass even if `resolvePluginRoot()` ignored `envPort` and used the real bundle path.
    expect(frontmatterDriverCall?.[2]).toContain(pluginRoot);
    expect(frontmatterDriverCall?.[2]).toContain(join('bridge', 'coral-cli.cjs'));
  });

  it('documents the deterministic scalar tiebreak rule', () => {
    expect(FRONTMATTER_SCALAR_TIEBREAK_RULE).toContain('lexicographically greatest');
    expect(FRONTMATTER_SCALAR_TIEBREAK_RULE).toContain('updatedAt uses the lexicographic maximum');
  });

  // The host type requires a `timeout`, which is what makes the invariant's exemption of the forwarding
  // adapter true — but a required field is satisfied by `0`, and `execFileSync` reads `0` as no bound. The
  // type check and the AST scan both pass on that; only an assertion on the value does not.
  it('bounds git merge-file with a positive timeout', () => {
    const body = 'Body that both sides keep.';
    const meta = SEED_META;
    const observed: { options: { stdio: 'ignore'; timeout: number } | null } = { options: null };

    mergeMarkdownRevisions(
      renderNote(meta, body),
      renderNote({ ...meta, tags: ['seed', 'ours'] }, body),
      renderNote({ ...meta, tags: ['seed', 'theirs'] }, body),
      'notes/merge-note.md',
      createFrontmatterMergeHost(root, observed),
    );

    expect(observed.options?.timeout, 'zero is what "no bound" looks like while still being a number').toBeGreaterThan(
      0,
    );
  });

  // `oursPath` is git's `%A` — the user's working-tree file, not a temp copy — and the driver writes it at the
  // end of every successful run. So the only thing standing between a `git merge-file` that never answered and
  // a silently truncated file is that this path refuses to reach the write at all.
  //
  // The previous test on this bound asserted only that the timeout was a positive number. That is the check
  // that passes while the failure it exists for is unhandled.
  it.each([
    ['a timeout', { code: 'ETIMEDOUT', status: null }],
    ['a launch failure', { code: 'ENOENT', status: null }],
    ['an error carrying nothing recognisable', {}],
    // Not a non-answer from the *port* — git ran and exited — but not a conflict count either. Above 127 the
    // number is an error code: 129 is a usage error, 255 is git refusing the inputs. Both were read as
    // "255 conflicts" and "129 conflicts" for as long as the predicate was `status > 0`.
    ['git refusing the inputs (255)', { status: 255 }],
    ['a usage error (129)', { status: 129 }],
  ])('refuses to touch the working-tree file when git merge-file answers with %s', (_label, props) => {
    const meta = SEED_META;
    const oursPath = join(root, 'note.md');
    const basePath = join(root, 'base.md');
    const theirsPath = join(root, 'theirs.md');
    const original = renderNote(meta, 'the body the user still has');
    writeFileSync(oursPath, original, 'utf-8');
    writeFileSync(basePath, renderNote(meta, 'base body'), 'utf-8');
    writeFileSync(theirsPath, renderNote(meta, 'incoming body'), 'utf-8');

    const written: string[] = [];
    const host: FrontmatterMergeDriverHost = {
      readFileSync,
      writeFileSync: (path, data, encoding) => {
        written.push(path);
        writeFileSync(path, data, encoding);
      },
      createTempDir: (prefix) => mkdtempSync(join(root, prefix)),
      rmSync,
      execFileSync: () => {
        throw Object.assign(new Error('no answer'), props);
      },
    };

    expect(() =>
      runFrontmatterMergeDriver({ basePath, oursPath, theirsPath, filePath: 'notes/note.md' }, host),
    ).toThrow(FrontmatterMergeUnavailableError);

    expect(written, 'the working-tree file must not be among the writes').not.toContain(oursPath);
    expect(readFileSync(oursPath, 'utf-8'), 'and it must be byte-identical to what the user had').toBe(original);
  });

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

  it('still treats the top of the conflict range as a count, not an error', () => {
    // git clamps its own conflict count at 127 so the error range stays distinguishable, so 127 is a real
    // answer and must still reach the write. A bound set one too low silently discards merges.
    const meta = SEED_META;
    const oursPath = join(root, 'clamped-note.md');
    const basePath = join(root, 'clamped-base.md');
    const theirsPath = join(root, 'clamped-theirs.md');
    writeFileSync(oursPath, renderNote(meta, 'ours body'), 'utf-8');
    writeFileSync(basePath, renderNote(meta, 'base body'), 'utf-8');
    writeFileSync(theirsPath, renderNote(meta, 'theirs body'), 'utf-8');

    const host: FrontmatterMergeDriverHost = {
      ...createFrontmatterMergeHost(root),
      execFileSync: () => {
        throw Object.assign(new Error('127 conflicts'), { status: 127 });
      },
    };

    expect(runFrontmatterMergeDriver({ basePath, oursPath, theirsPath, filePath: 'notes/clamped.md' }, host)).toEqual({
      status: 127,
      bodyConflict: true,
    });
  });

  it('still writes the working-tree file when git merge-file reports conflicts', () => {
    const meta = SEED_META;
    const oursPath = join(root, 'note.md');
    const basePath = join(root, 'base.md');
    const theirsPath = join(root, 'theirs.md');
    writeFileSync(oursPath, renderNote(meta, 'our body'), 'utf-8');
    writeFileSync(basePath, renderNote(meta, 'base body'), 'utf-8');
    writeFileSync(theirsPath, renderNote(meta, 'their body'), 'utf-8');

    // A non-zero *exit* is an answer — that many conflicts — and the driver owns writing the result.
    const result = runFrontmatterMergeDriver(
      { basePath, oursPath, theirsPath, filePath: 'notes/note.md' },
      createFrontmatterMergeHost(root),
    );

    expect(result.status).toBeGreaterThan(0);
    expect(readFileSync(oursPath, 'utf-8'), 'a real conflict still produces markers in the file').toContain('<<<<<<<');
  });
});
