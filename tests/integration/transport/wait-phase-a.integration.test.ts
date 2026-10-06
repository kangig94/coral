import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'coral-wait-phase-a-'));

beforeAll(() => {
  for (const variant of ['real', 'no-handover', 'include-missing', 'property-decoder', 'unbounded-observer'])
    symlinkSync(sharedFixture(`phase-${variant}`), join(directory, `${variant}.mjs`));
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function probe(transport: string, scenario: string, variant = 'real'): string {
  return execFileSync(process.execPath, [join(directory, `${variant}.mjs`), transport, scenario], {
    env: { PATH: process.env.PATH, HOME: mkdtempSync(join(directory, 'home-')), LANG: 'C.UTF-8', TMPDIR: '/tmp' },
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

it.each(['http', 'ipc'])('%s carries the handover notice on every wait stream', (transport) => {
  expect(probe(transport, 'handover')).toContain('"type":"handover"');
});

it.each(['http', 'ipc'])('%s excludes a missing sibling from the exact continuation', (transport) => {
  expect(probe(transport, 'missing')).not.toContain('ghost');
});

it('HTTP softly rejects a header cursor in an old shape', () => {
  expect(probe('http', 'unknown-header')).toContain('unknown-header');
});

it('the server deadline bounds an observer that never resolves', () => {
  expect(() => probe('ipc', 'observer')).not.toThrow();
});

it.each([
  ['http', 'handover', 'no-handover'],
  ['http', 'missing', 'include-missing'],
  ['ipc', 'codec', 'property-decoder'],
  ['ipc', 'observer', 'unbounded-observer'],
])('negative control %s/%s/%s fails its contract assertion', (transport, scenario, variant) => {
  try {
    probe(transport, scenario, variant);
    expect.fail('Control passed its contract assertion');
  } catch (error: unknown) {
    expect(error).toMatchObject({ status: 1, stderr: expect.stringContaining('AssertionError') });
  }
});
