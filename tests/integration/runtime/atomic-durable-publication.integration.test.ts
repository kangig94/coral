import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';

const directory = mkdtempSync(join(tmpdir(), 'coral-atomic-publication-'));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('cleans only its own stage when publication fails', () => {
  const target = join(directory, 'directory-target');
  const runtime = createRealRuntime('prod', { baseDir: directory });
  runtime.storage.mkdirSync(target);
  const sibling = `${target}.stage-paused-writer`;
  writeFileSync(sibling, 'still owned');
  expect(() => runtime.storage.writeAtomicDurableSync(target, 'content')).toThrow();
  expect(readdirSync(directory).filter((name) => name.startsWith('directory-target.stage-'))).toEqual([
    'directory-target.stage-paused-writer',
  ]);
});
