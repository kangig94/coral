import { afterEach, expect, it } from 'vitest';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pruneJobExports } from '#src/jobs/export-retention.js';
import { createRetentionFixture, RETENTION_CUTOFF, RETENTION_NOW } from '#tests/helpers/storage-retention.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

for (const access of ['cwd', 'directory-handle'] as const) {
  for (const state of ['absent', 'terminal'] as const) {
    for (const timing of ['before-prune', 'during-enumeration', 'after-first-delete', 'no-write'] as const) {
      it.skipIf(access === 'directory-handle' && process.platform !== 'linux')(
        `preserves an existing ${access} writer (${state}, ${timing})`,
        async () => {
          const f = createRetentionFixture();
          fixtures.push(f);
          const storage = f.runtime.storage;
          const root = f.runtime.paths.coral.exports.jobsRoot;
          const original = join(root, 'existing-writer');
          const top = join(original, 'provider-artifacts');
          storage.mkdirSync(top, { recursive: true });
          for (const name of ['first.jsonl', 'second.jsonl']) storage.writeFileSync(join(top, name), 'old');
          for (const path of [original, top, join(top, 'first.jsonl'), join(top, 'second.jsonl')])
            utimesSync(path, 1, 1);
          const writer = spawn(
            process.execPath,
            [
              '-e',
              `const fs = require('node:fs');
               const prefix = ${access === 'cwd' ? "'.'" : "'/proc/self/fd/' + fs.openSync('.', 'r')"};
               ${access === 'directory-handle' ? "process.chdir('/');" : ''}
               process.stdin.once('data', () => {
                 fs.writeFileSync(prefix + '/fresh.jsonl', 'fresh content');
                 fs.utimesSync(prefix + '/fresh.jsonl', ${RETENTION_NOW / 1000}, ${RETENTION_NOW / 1000});
                 fs.utimesSync(prefix, ${RETENTION_NOW / 1000}, ${RETENTION_NOW / 1000});
                 console.log('written');
               });
               console.log('ready');`,
            ],
            { cwd: top, stdio: ['pipe', 'pipe', 'pipe'] },
          );
          const closed = once(writer, 'close');
          let injected = false;
          let retired = '';
          const write = async () => {
            const written = once(writer.stdout, 'data');
            writer.stdin.end('write');
            await written;
            expect((await closed)[0]).toBe(0);
            injected = true;
          };
          const iterate = storage.iterateDirectory.bind(storage);
          storage.iterateDirectory = async function* (directory) {
            if (basename(directory) !== 'provider-artifacts') {
              yield* iterate(directory);
              return;
            }
            retired = directory;
            if (timing === 'during-enumeration') await write();
            for await (const child of iterate(directory)) {
              yield child;
              if (timing === 'after-first-delete' && !injected) {
                expect(storage.existsSync(join(directory, child))).toBe(false);
                await write();
                storage.mkdirSync(original);
                storage.writeFileSync(join(original, 'writer.md'), 'new writer');
              }
            }
          };
          try {
            await Promise.race([
              once(writer.stdout, 'data'),
              closed.then(([code]) => {
                throw new Error(`writer exited before readiness: ${code}`);
              }),
            ]);
            if (timing === 'before-prune') await write();
            await pruneJobExports({
              db: f.db,
              runtime: f.runtime,
              cutoff: RETENTION_CUTOFF,
              afterId: '',
              budget: f.budget,
              jobState: () => (state === 'absent' ? { kind: 'absent' } : { kind: 'terminal', terminalAt: 1 }),
              resultHold: () => 'released',
              mutate: (operation) => operation(),
            });
            if (timing === 'no-write') {
              expect(storage.existsSync(original)).toBe(false);
              expect(storage.existsSync(retired)).toBe(false);
              expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'deleted' }));
            } else {
              const kept =
                timing === 'after-first-delete'
                  ? join(root, basename(join(retired, '..')).replace('.retiring-', 'kept-retiring-'))
                  : original;
              expect(injected).toBe(true);
              expect(storage.readFileSync(join(kept, 'provider-artifacts', 'fresh.jsonl'), 'utf-8')).toBe(
                'fresh content',
              );
              expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', subject: kept }));
              expect(f.outcomes.some((outcome) => outcome.kind === 'failed' || outcome.kind === 'deleted')).toBe(false);
              if (timing === 'after-first-delete')
                expect(storage.readFileSync(join(original, 'writer.md'), 'utf-8')).toBe('new writer');
            }
          } finally {
            if (writer.exitCode === null) writer.kill();
            await closed;
          }
        },
      );
    }
  }
}

for (const backend of ['filesystem', 'memory'] as const) {
  for (const state of ['absent', 'terminal'] as const) {
    it(`preserves a path-based write during recursive enumeration (${backend}, ${state})`, async () => {
      const f = createRetentionFixture();
      fixtures.push(f);
      let now = 1000;
      if (backend === 'memory') f.runtime.storage = new InMemoryStorage({ now: () => now });
      const storage = f.runtime.storage;
      const path = join(f.runtime.paths.coral.exports.jobsRoot, 'writer-interleaving');
      const top = join(path, 'provider-artifacts');
      const fresh = join(top, 'new-session.jsonl');
      storage.mkdirSync(top, { recursive: true });
      storage.writeFileSync(join(top, 'old-session.jsonl'), 'old');
      if (backend === 'filesystem') {
        for (const p of [join(top, 'old-session.jsonl'), top, path]) utimesSync(p, 1, 1);
      }
      now = RETENTION_NOW;
      const iterate = storage.iterateDirectory.bind(storage);
      let injected = false;
      storage.iterateDirectory = async function* (directory) {
        if (basename(directory) === 'provider-artifacts') {
          await Promise.resolve();
          injected = true;
          storage.mkdirSync(top, { recursive: true });
          storage.writeFileSync(fresh, 'fresh content');
          if (backend === 'filesystem') {
            utimesSync(fresh, RETENTION_NOW / 1000, RETENTION_NOW / 1000);
            utimesSync(top, RETENTION_NOW / 1000, RETENTION_NOW / 1000);
          }
          expect(storage.lstatSync(top, { bigint: true }).mtimeNs).toBeGreaterThan(
            BigInt(RETENTION_CUTOFF) * 1_000_000n,
          );
        }
        yield* iterate(directory);
      };
      await pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: RETENTION_CUTOFF,
        afterId: '',
        budget: f.budget,
        jobState: () => (state === 'absent' ? { kind: 'absent' } : { kind: 'terminal', terminalAt: 1 }),
        resultHold: () => 'released',
        mutate: (operation) => operation(),
      });
      expect(injected).toBe(true);
      expect(storage.existsSync(fresh)).toBe(true);
      expect(storage.readFileSync(fresh, 'utf-8')).toBe('fresh content');
    });
  }
}

for (const recent of ['none', 'root', 'file', 'directory'] as const) {
  for (const recreated of [false, true]) {
    it(`recovers a leftover retirement (${recent}, recreated: ${recreated})`, async () => {
      const f = createRetentionFixture();
      fixtures.push(f);
      const storage = f.runtime.storage;
      const root = f.runtime.paths.coral.exports.jobsRoot;
      const id = 'crashed-job';
      const original = join(root, id);
      const name = `.retiring-${id}-${randomUUID()}`;
      const retired = join(root, name);
      storage.mkdirSync(join(retired, 'provider-artifacts'), { recursive: true });
      storage.writeFileSync(join(retired, 'result.md'), 'retired result');
      for (const child of ['', 'provider-artifacts', 'result.md']) utimesSync(join(retired, child), 1, 1);
      if (recent !== 'none') {
        const child = recent === 'root' ? '' : recent === 'file' ? 'result.md' : 'provider-artifacts';
        utimesSync(join(retired, child), RETENTION_NOW / 1000, RETENTION_NOW / 1000);
      }
      if (recreated) {
        if (recreated) {
          storage.mkdirSync(original);
          storage.writeFileSync(join(original, 'writer.md'), 'new writer');
        }
        utimesSync(original, RETENTION_NOW / 1000, RETENTION_NOW / 1000);
        utimesSync(join(original, 'writer.md'), RETENTION_NOW / 1000, RETENTION_NOW / 1000);
      }
      await pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: RETENTION_CUTOFF,
        afterId: 'z-interrupted-cursor',
        budget: f.budget,
        jobState: () => ({ kind: 'absent' }),
        resultHold: () => 'released',
        mutate: (operation) => operation(),
      });
      expect(storage.existsSync(retired)).toBe(false);
      if (recent === 'none') expect(storage.existsSync(join(original, 'result.md'))).toBe(false);
      else {
        const kept = recreated ? join(root, name.replace('.retiring-', 'kept-retiring-')) : original;
        expect(storage.readFileSync(join(kept, 'result.md'), 'utf-8')).toBe('retired result');
        expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', subject: kept }));
      }
      if (recreated) expect(storage.readFileSync(join(original, 'writer.md'), 'utf-8')).toBe('new writer');
    });
  }
}

it.each(['nonterminal', 'unknown', 'required', 'regression'] as const)(
  'restores a leftover retirement whose deletion proof is %s',
  async (proof) => {
    const f = createRetentionFixture();
    fixtures.push(f);
    const storage = f.runtime.storage;
    const root = f.runtime.paths.coral.exports.jobsRoot;
    const original = join(root, 'protected-job');
    const retired = join(root, `.retiring-protected-job-${randomUUID()}`);
    storage.mkdirSync(retired, { recursive: true });
    storage.writeFileSync(join(retired, 'result.md'), 'protected result');
    for (const child of ['', 'result.md']) utimesSync(join(retired, child), 1, 1);
    await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState: () => (proof === 'required' ? { kind: 'absent' } : { kind: proof }),
      resultHold: () => (proof === 'required' ? 'required' : 'released'),
      mutate: (operation) => operation(),
    });
    expect(storage.readFileSync(join(original, 'result.md'), 'utf-8')).toBe('protected result');
    expect(storage.existsSync(retired)).toBe(false);
    expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', subject: original }));
  },
);

it.each([
  ['root', false],
  ['root', true],
  ['directory', false],
  ['directory', true],
] as const)('restores activity observed after rename (%s, recreated: %s)', async (recent, recreated) => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const storage = f.runtime.storage;
  const root = f.runtime.paths.coral.exports.jobsRoot;
  const original = join(root, 'rename-race');
  storage.mkdirSync(join(original, 'provider-artifacts'), { recursive: true });
  storage.writeFileSync(join(original, 'provider-artifacts', 'old.md'), 'old');
  for (const child of ['', 'provider-artifacts']) utimesSync(join(original, child), 1, 1);
  const rename = storage.renameSync;
  let retired = '';
  storage.renameSync = (from, to) => {
    rename(from, to);
    if (from === original) {
      retired = String(to);
      const target = recent === 'root' ? retired : join(retired, 'provider-artifacts');
      storage.writeFileSync(join(target, 'fresh.md'), 'fresh during rename');
      utimesSync(target, RETENTION_NOW / 1000, RETENTION_NOW / 1000);
      if (recreated) {
        storage.mkdirSync(original);
        storage.writeFileSync(join(original, 'writer.md'), 'new writer');
      }
    }
  };
  await pruneJobExports({
    db: f.db,
    runtime: f.runtime,
    cutoff: RETENTION_CUTOFF,
    afterId: '',
    budget: f.budget,
    jobState: () => ({ kind: 'terminal', terminalAt: 1 }),
    resultHold: () => 'released',
    mutate: (operation) => operation(),
  });
  const kept = recreated ? join(root, basename(retired).replace('.retiring-', 'kept-retiring-')) : original;
  const target = recent === 'root' ? kept : join(kept, 'provider-artifacts');
  expect(storage.readFileSync(join(target, 'fresh.md'), 'utf-8')).toBe('fresh during rename');
  if (recreated) expect(storage.readFileSync(join(original, 'writer.md'), 'utf-8')).toBe('new writer');
  expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', subject: kept }));
});

for (const refresh of ['none', 'recent', 'before-cutoff'] as const) {
  for (const recreated of [false, true]) {
    it(`checks overwritten nested files immediately before deletion (${refresh}, recreated: ${recreated})`, async () => {
      const f = createRetentionFixture();
      fixtures.push(f);
      const storage = f.runtime.storage;
      const root = f.runtime.paths.coral.exports.jobsRoot;
      const original = join(root, 'overwrite-race');
      const artifact = join(original, 'provider-artifacts', 'session.jsonl');
      storage.mkdirSync(dirname(artifact), { recursive: true });
      storage.writeFileSync(artifact, 'old artifact');
      for (const path of [original, dirname(artifact), artifact]) utimesSync(path, 1, 1);
      const stat = storage.lstatSync;
      let pending = false;
      let writerRan = false;
      let retired = '';
      storage.lstatSync = ((path, options) => {
        const result = stat(path, options);
        if (String(path).endsWith('/provider-artifacts/session.jsonl')) pending = true;
        return result;
      }) as typeof stat;
      await pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: RETENTION_CUTOFF,
        afterId: '',
        budget: f.budget,
        jobState: () => ({ kind: 'terminal', terminalAt: 1 }),
        resultHold: () => 'released',
        mutate: (operation) => {
          if (pending && !writerRan && refresh !== 'none') {
            retired = storage.readdirSync(root).find((name) => name.startsWith('.retiring-')) ?? '';
            if (retired) {
              const path = join(root, retired, 'provider-artifacts', 'session.jsonl');
              storage.writeFileSync(path, 'fresh artifact');
              const seconds = refresh === 'recent' ? RETENTION_NOW / 1000 : 2;
              utimesSync(path, seconds, seconds);
              if (recreated) storage.mkdirSync(original);
              writerRan = true;
            }
          }
          return operation();
        },
      });
      if (refresh === 'none') {
        expect(writerRan).toBe(false);
        expect(storage.existsSync(original)).toBe(false);
      } else {
        expect(writerRan).toBe(true);
        const kept = recreated ? join(root, retired.replace('.retiring-', 'kept-retiring-')) : original;
        expect(storage.readFileSync(join(kept, 'provider-artifacts', 'session.jsonl'), 'utf-8')).toBe('fresh artifact');
        expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', subject: kept }));
      }
    });
  }
}
