#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const state = process.argv[2];

const recordKbSearch = (file) => {
  const search = spawnSync(process.execPath, [process.argv[3], 'kb', 'search', 'durable succession'], {
    cwd: path.dirname(path.dirname(state)),
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  fs.writeFileSync(path.join(state, file), JSON.stringify({
    status: search.status,
    stdout: search.stdout,
    stderr: search.stderr,
    error: search.error?.message,
  }));
};

fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, 'running'), String(process.pid));
recordKbSearch('kb-search-before.json');
process.stdout.write('before handover\n');

let afterHandover = false;
const poll = () => {
  if (!afterHandover && fs.existsSync(path.join(state, 'continue'))) {
    afterHandover = true;
    process.stdout.write('after handover\n');
    recordKbSearch('kb-search.json');
    fs.writeFileSync(path.join(state, 'after-handover'), 'emitted');
  }
  setTimeout(poll, 20);
};
poll();

process.on('SIGTERM', () => {
  fs.writeFileSync(path.join(state, 'cancelled'), 'cancelled');
  process.stdout.write('cancelled by successor\n');
  process.exit(0);
});
