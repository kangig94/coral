#!/usr/bin/env node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'verify-runtime-cutover-fixture-'));

try {
  await mkdir(join(root, 'src/bad'), { recursive: true });
  await mkdir(join(root, 'src/execution'), { recursive: true });
  await mkdir(join(root, 'src/runtime'), { recursive: true });

  await writeFile(join(root, 'src/bad/importer.ts'), "import x from '../execution/runtime.js';\nexport {};\n");
  await writeFile(join(root, 'src/execution/runtime.ts'), 'export const placeholder = 1;\n');
  await writeFile(join(root, 'src/runtime/ports.ts'), 'export interface Runtime {}\n');

  const scriptPath = fileURLToPath(new URL('../verify-runtime-cutover.mjs', import.meta.url));
  const proc = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: {
      ...process.env,
      CORAL_VERIFY_ROOT: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise((resolveExit) => {
    proc.on('exit', resolveExit);
  });

  if (exitCode === 0) {
    console.error('[fixture] FAIL: verifier passed on synthetic bad tree');
    if (stdout.length > 0) {
      console.error(stdout.trim());
    }
    process.exit(1);
  }

  if (!stderr.includes('src/bad/importer.ts') || !stderr.includes('src/execution/runtime.ts')) {
    console.error('[fixture] FAIL: violation output missing importer path or resolved target');
    if (stderr.length > 0) {
      console.error(stderr.trim());
    }
    process.exit(1);
  }

  console.log('[fixture] OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
