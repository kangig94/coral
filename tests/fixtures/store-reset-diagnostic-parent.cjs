'use strict';

const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');

const [programPath, storeDbPath, holderPath, epoch] = process.argv.slice(2);
if (programPath === undefined || storeDbPath === undefined || holderPath === undefined || epoch === undefined) {
  process.exit(2);
}

const child = spawn(
  process.execPath,
  ['--input-type=commonjs', '--eval', readFileSync(programPath, 'utf-8'), storeDbPath, holderPath, epoch],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);
child.once('exit', (code, signal) => {
  process.exitCode = signal === null ? (code ?? 1) : 1;
});
