import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const source = process.argv[2];
const destination = process.argv[3];
if (source === undefined || destination === undefined) throw new Error('Expected construction paths.');

mkdirSync(source, { recursive: true, mode: 0o700 });
const lock = new DatabaseSync(join(source, '.lock'));
lock.exec('BEGIN; SELECT count(*) FROM sqlite_schema');
process.stdout.write(`${JSON.stringify({ source, destination })}\n`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
