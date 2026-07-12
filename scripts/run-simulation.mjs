#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

mkdirSync('clients/build', { recursive: true });

await esbuild.build({
  entryPoints: ['tools/simulation/cli.ts'],
  outfile: 'clients/build/coral-simulation.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['node:*', 'better-sqlite3'],
  loader: { '.sql': 'text' },
  minify: false,
});

const result = spawnSync(process.execPath, ['clients/build/coral-simulation.cjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
