import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import {
  markDurableCliExecutionEntered,
  readDurableCliExecutionReceipt,
  recordDurableCliExecution,
} from '#src/jobs/durable-cli-execution.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

it.each(['entered', 'refused', 'unknown-root', 'unplaced'] as const)(
  'flushes entry evidence over real IPC and disconnects with %s placement',
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-wrapper-ipc-'));
    const db = newRawDatabase(':memory:');
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const wrapper = join(directory, 'wrapper.mjs');
    const launch = join(directory, 'launch.json');
    writeFileSync(
      launch,
      JSON.stringify({ version: 1, command: 'fake-cli', args: [], cwd: null, prompt: '', startTime: 'now' }),
    );
    writeFileSync(join(directory, 'env.json'), '{}');
    try {
      await build({
        entryPoints: ['src/runtime/durable-cli-wrapper.ts'],
        outfile: wrapper,
        bundle: true,
        platform: 'node',
        format: 'esm',
        plugins: [
          {
            name: 'external-process-fixture',
            setup(plugin) {
              plugin.onResolve({ filter: /^(node:child_process)$|\/failure-domain\.js$/ }, (args) =>
                args.path === 'node:child_process' && !args.importer.endsWith('/durable-cli-wrapper.ts')
                  ? undefined
                  : { path: args.path, namespace: 'fixture' },
              );
              plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
                contents:
                  args.path === 'node:child_process'
                    ? `import { EventEmitter } from 'node:events'; import { PassThrough } from 'node:stream'; export const spawn = () => Object.assign(new EventEmitter(), { pid: 2147483647, stdin: new PassThrough() });`
                    : `export const inheritedFailureDomainRoot = () => ({ kind: '${mode === 'unknown-root' ? 'unknown' : 'placed'}', root: '/fixture' }); export const enterPayloadDomain = () => ({ kind: '${mode === 'entered' ? 'entered' : 'refused'}' });`,
              }));
            },
          },
        ],
      });
      const child = fork(wrapper, [launch], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const incarnation = testIncarnation('ipc-wrapper');
      if (child.pid === undefined) throw new Error('wrapper did not start');
      const identity = { jobId: 'ipc-job', execution: 1, pid: child.pid, incarnation };
      recordDurableCliExecution(db, identity);
      const messages: unknown[] = [];
      let output = '';
      let errors = '';
      child.stdout?.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        errors += String(chunk);
      });
      child.on('message', (message) => {
        messages.push(message);
        if ((message as { kind?: string }).kind === 'durable-payload-entered')
          markDurableCliExecutionEntered(db, identity);
      });
      const closed = once(child, 'close');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        child.send({
          kind: 'runtime-start-published',
          failureDomain: mode === 'unplaced' ? null : { root: '/fixture', path: '/fixture/job-ipc-1' },
        });
        expect(await closed).toEqual([0, null]);
        expect(errors).toBe('');
        expect(output).toContain('"type":"runtime"');
        expect(messages).toEqual(mode === 'entered' ? [{ kind: 'durable-payload-entered' }] : []);
        expect(readDurableCliExecutionReceipt(db, 'ipc-job', identity)?.phase).toBe(
          mode === 'entered' ? 'entered' : 'planned',
        );
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
