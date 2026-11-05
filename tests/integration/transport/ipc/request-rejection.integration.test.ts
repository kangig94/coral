import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'coral-ipc-rejection-'));
beforeAll(async () => {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await build({
    entryPoints: [join(root, 'tests/fixtures/ipc/request-rejection.ts')],
    outfile: join(directory, 'probe.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    loader: { '.sql': 'text' },
  });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function runProbe(scenario: string, ...args: string[]): string {
  const output = execFileSync(process.execPath, [join(directory, 'probe.mjs'), scenario, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: mkdtempSync(join(directory, 'home-')),
      LANG: 'C.UTF-8',
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return output;
}
it.each([
  'ping',
  'health',
  'cached',
  'write',
  'unexpected',
  'lifecycle',
  'admission',
  'counted-end',
  'succession-error',
  'write-throw',
  'inherited',
  'forwarded',
  'challenge-handoff',
  'challenge-handoff-log',
])('%s contains socket-task failures', (scenario) => {
  expect(runProbe(scenario)).toContain('SURVIVED');
});

const lifecycleCases = [
  { lifecycle: 'starting', isDraining: false, status: 'starting' },
  { lifecycle: 'starting', isDraining: true, status: 'draining' },
  { lifecycle: 'kernel-ready', isDraining: false, status: 'starting' },
  { lifecycle: 'kernel-ready', isDraining: true, status: 'draining' },
  { lifecycle: 'running', isDraining: false, status: 'ok' },
  { lifecycle: 'running', isDraining: true, status: 'draining' },
  { lifecycle: 'draining', isDraining: false, status: 'draining' },
  { lifecycle: 'draining', isDraining: true, status: 'draining' },
  { lifecycle: 'stopped', isDraining: false, status: 'draining' },
  { lifecycle: 'stopped', isDraining: true, status: 'draining' },
];
it('production ping follows the status truth table on one server', () => {
  expect(
    runProbe(
      'ping-assembly',
      JSON.stringify(
        lifecycleCases.map(({ lifecycle, isDraining, status }) => ({
          lifecycle,
          isDraining,
          incarnation: false,
          sentinel: false,
          expected: { status },
        })),
      ),
    ),
  ).toContain('SURVIVED');
});

it.each([
  {
    name: 'present',
    incarnation: true,
    sentinel: true,
    expected: {
      incarnation: 'linux:00000000-0000-4000-8000-000000000000:123',
      sentinel: { version: 1, id: 'test-sentinel' },
    },
  },
  { name: 'absent', incarnation: false, sentinel: false, expected: {} },
])('production ping preserves $name optional identity fields', ({ incarnation, sentinel, expected }) => {
  expect(
    runProbe(
      'ping-assembly',
      JSON.stringify([
        {
          lifecycle: 'running',
          isDraining: false,
          incarnation,
          sentinel,
          expected: { status: 'ok', ...expected },
        },
      ]),
    ),
  ).toContain('SURVIVED');
});

it('production ping stays live while the writer is parked', () => {
  expect(
    runProbe(
      'ping-assembly',
      JSON.stringify([
        {
          lifecycle: 'draining',
          isDraining: true,
          incarnation: false,
          sentinel: false,
          expected: { status: 'draining' },
        },
      ]),
    ),
  ).toContain('SURVIVED');
});
