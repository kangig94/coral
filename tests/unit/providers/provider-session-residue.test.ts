import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactCleanupRuntime } from '#src/providers/contract.js';
import { discardCodexRolloutResidue } from '#src/providers/codex/artifacts.js';
import { discardClaudeSessionResidue } from '#src/providers/claude/artifacts.js';
import { createRealRuntime } from '#src/runtime/real.js';

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const ROOT = '01a00000-0000-7000-8000-000000000000';
const CHILD = '01a00000-0000-7000-8000-000000000001';
const GRANDCHILD = '01a00000-0000-7000-8000-000000000002';
const UNRELATED_PARENT = '01a00000-0000-7000-8000-00000000000f';
const UNRELATED_FORK = '01a00000-0000-7000-8000-000000000010';

let root: string;
const realStorage = createRealRuntime('prod').storage;

function runtime(storage: ArtifactCleanupRuntime['storage'] = realStorage): ArtifactCleanupRuntime {
  return { storage, time: { now: () => NOW } } as unknown as ArtifactCleanupRuntime;
}

/** Wraps the real storage, failing `unlinkSync` for the named paths. */
function storageFailingUnlink(paths: readonly string[]): ArtifactCleanupRuntime['storage'] {
  return new Proxy(realStorage, {
    get(target, property, receiver) {
      if (property === 'unlinkSync') {
        return (path: string) => {
          if (paths.includes(path)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
          return target.unlinkSync(path);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coral-residue-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discardCodexRolloutResidue', () => {
  function dayDirectory(date: Date): string {
    const directory = join(
      root,
      'sessions',
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    );
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  function rollout(threadId: string, parent: string | null, date = new Date(NOW)): string {
    const source = parent === null ? 'vscode' : { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } };
    const path = join(dayDirectory(date), `rollout-2026-09-20T12-00-00-${threadId}.jsonl`);
    const header = {
      type: 'session_meta',
      payload: { id: threadId, originator: 'coral', source, base_instructions: { text: 'x'.repeat(200_000) } },
    };
    writeFileSync(path, `${JSON.stringify(header)}\n{"type":"event"}\n`);
    return path;
  }

  function discard(storage?: ArtifactCleanupRuntime['storage']) {
    return discardCodexRolloutResidue({
      rootThreadId: ROOT,
      sessionsRoot: join(root, 'sessions'),
      since: NOW - 60 * 60 * 1000,
      runtime: runtime(storage),
    });
  }

  it('discards every descendant of the root, deepest first, and nothing else', () => {
    const primary = rollout(ROOT, null);
    const child = rollout(CHILD, ROOT);
    const grandchild = rollout(GRANDCHILD, CHILD);
    const unrelated = rollout(UNRELATED_FORK, UNRELATED_PARENT);

    const residue = discard();

    expect(residue.discarded).toEqual([grandchild, child]);
    expect(residue.retained).toEqual([]);
    expect(existsSync(primary)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('keeps an ancestor whose descendant it could not remove, so the next call can still reach both', () => {
    const child = rollout(CHILD, ROOT);
    const grandchild = rollout(GRANDCHILD, CHILD);

    const first = discard(storageFailingUnlink([grandchild]));

    expect(first.discarded).toEqual([]);
    expect(first.retained.map(({ path }) => path)).toEqual([grandchild, child]);
    expect(existsSync(child)).toBe(true);

    expect(discard().discarded).toEqual([grandchild, child]);
  });

  it('never deletes a rollout whose header it cannot read, nor anything reached only through it', () => {
    const unreadable = join(dayDirectory(new Date(NOW)), `rollout-2026-09-20T12-00-00-${CHILD}.jsonl`);
    writeFileSync(unreadable, '{"type":"session_meta","payload":');
    const beneathIt = rollout(GRANDCHILD, CHILD);

    expect(discard().discarded).toEqual([]);
    expect(existsSync(unreadable)).toBe(true);
    expect(existsSync(beneathIt)).toBe(true);
  });

  it('never deletes a rollout whose header names another thread than its filename', () => {
    const mismatched = join(dayDirectory(new Date(NOW)), `rollout-2026-09-20T12-00-00-${CHILD}.jsonl`);
    const header = {
      type: 'session_meta',
      payload: { id: UNRELATED_FORK, source: { subagent: { thread_spawn: { parent_thread_id: ROOT } } } },
    };
    writeFileSync(mismatched, `${JSON.stringify(header)}\n`);

    expect(discard().discarded).toEqual([]);
    expect(existsSync(mismatched)).toBe(true);
  });

  it('ignores a rollout last written before the session began', () => {
    const stale = rollout(CHILD, ROOT, new Date(2020, 0, 1));
    const written = new Date(2020, 0, 1);
    utimesSync(stale, written, written);

    expect(discard().discarded).toEqual([]);
    expect(existsSync(stale)).toBe(true);
  });
});

describe('discardClaudeSessionResidue', () => {
  const REF = 'f350fd1e-61fa-4082-a859-9c4917e2103d';
  const OTHER_REF = '0a0b0c0d-0000-4000-8000-000000000000';

  function project(name = '-home-user-project'): string {
    const directory = join(root, 'projects', name);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  function discard(conversationRef = REF, storage?: ArtifactCleanupRuntime['storage']) {
    return discardClaudeSessionResidue({
      conversationRef,
      projectsRoot: join(root, 'projects'),
      runtime: runtime(storage),
    });
  }

  it('removes the conversation directory and everything under it, leaving other conversations alone', () => {
    const directory = project();
    mkdirSync(join(directory, REF, 'tool-results'), { recursive: true });
    writeFileSync(join(directory, REF, 'tool-results', 'a.txt'), 'a');
    mkdirSync(join(directory, OTHER_REF, 'tool-results'), { recursive: true });
    writeFileSync(join(directory, OTHER_REF, 'tool-results', 'b.txt'), 'b');

    const residue = discard();

    expect(residue.retained).toEqual([]);
    expect(existsSync(join(directory, REF))).toBe(false);
    expect(existsSync(join(directory, OTHER_REF, 'tool-results', 'b.txt'))).toBe(true);
  });

  it('does not follow a conversation directory that is a link', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(project(), REF), 'dir');

    discard();

    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('does not descend into an entry that is no longer a real directory when it gets there', () => {
    const directory = project();
    const inner = join(directory, REF, 'tool-results');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'outside-if-followed.txt'), 'x');
    const swapped = new Proxy(realStorage, {
      get(target, property, receiver) {
        if (property === 'lstatSync') {
          return (path: string) =>
            path === inner
              ? { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true }
              : target.lstatSync(path);
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const residue = discard(REF, swapped);

    expect(existsSync(join(inner, 'outside-if-followed.txt'))).toBe(true);
    expect(residue.retained.map(({ path }) => path)).toContain(inner);
  });

  it('keeps a directory it could not empty and reports what it kept', () => {
    const directory = project();
    mkdirSync(join(directory, REF, 'tool-results'), { recursive: true });
    const stuck = join(directory, REF, 'tool-results', 'stuck.txt');
    const removable = join(directory, REF, 'tool-results', 'fine.txt');
    writeFileSync(stuck, 's');
    writeFileSync(removable, 'f');

    const residue = discard(REF, storageFailingUnlink([stuck]));

    expect(existsSync(removable)).toBe(false);
    expect(existsSync(stuck)).toBe(true);
    expect(residue.retained.map(({ path }) => path)).toEqual([stuck]);
  });

  it('refuses a conversation id that is not a single path segment', () => {
    const directory = project();
    mkdirSync(join(directory, 'victim'), { recursive: true });
    writeFileSync(join(directory, 'victim', 'keep.txt'), 'keep');

    expect(discard('../victim')).toEqual({ discarded: [], retained: [] });
    expect(discard('')).toEqual({ discarded: [], retained: [] });
    expect(existsSync(join(directory, 'victim', 'keep.txt'))).toBe(true);
  });
});
