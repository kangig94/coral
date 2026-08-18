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
  mergeMarkdownRevisions,
  type FrontmatterMergeDriverHost,
} from '#src/kb/curate/frontmatter-merge-driver.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import type { KbNoteFrontmatter } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';

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

  it('registers the frontmatter merge driver alongside the entity-graph driver', () => {
    const pluginRoot = join(root, 'plugin root');
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
    const meta = {
      tags: ['seed'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };
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
});
