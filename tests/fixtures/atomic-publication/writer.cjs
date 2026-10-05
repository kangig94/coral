const assert = require('node:assert/strict');
const fs = require('node:fs');

const [bundle, target, mode, ready, release] = process.argv.slice(2);
const originalRename = fs.renameSync;
if (mode === 'held') {
  fs.renameSync = (source, destination) => {
    if (destination === target) {
      fs.writeFileSync(ready, source);
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) Atomics.wait(sleeper, 0, 0, 10);
    }
    return originalRename(source, destination);
  };
}
const { createRealRuntime } = require(bundle);
const storage = createRealRuntime('prod', { baseDir: process.env.HOME }).storage;
const count = mode === 'concurrent' ? 32 : 1;
let failed = 0;
let invalid = 0;
for (let i = 0; i < count; i++) {
  const value = JSON.stringify({ padding: 'x'.repeat(mode === 'concurrent' ? 64 * 1024 : 1024), writer: process.pid, i });
  try {
    assert.equal(storage.writeAtomicDurableSync(target, value), true, 'owned publication failed');
  } catch (error) {
    if (mode === 'held') throw error;
    failed++;
  }
  try {
    const published = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(published.padding, 'x'.repeat(mode === 'concurrent' ? 64 * 1024 : 1024));
    assert.ok(Number.isInteger(published.writer));
  } catch { invalid++; }
}
console.log(JSON.stringify({ failed, invalid, count }));
