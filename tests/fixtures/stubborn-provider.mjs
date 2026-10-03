import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
  }
});
