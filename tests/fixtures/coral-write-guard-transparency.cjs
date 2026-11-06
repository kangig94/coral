const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { finished } = require('node:stream/promises');

const remove = fs.rmSync.bind(fs);
const root = process.argv[4];
const protectedRoot = path.join(root, '.coral');
const reports = path.join(root, 'reports');
fs.mkdirSync(protectedRoot);
fs.mkdirSync(reports);
const callback = (invoke) =>
  new Promise((resolve, reject) => invoke((error, value) => (error ? reject(error) : resolve(value))));

async function children() {
  const results = [];
  const input = 'process.stdout.write("kept:"+process.env.CORAL_ALLOWED_VALUE)';
  const forkFile = path.join(root, 'fork.cjs');
  fs.writeFileSync(
    forkFile,
    'process.send({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.CORAL_ALLOWED_VALUE});process.disconnect();',
  );
  const options = { encoding: 'utf8', input, env: { CORAL_ALLOWED_VALUE: 'retained' }, cwd: root };
  const forms = [
    [],
    [undefined],
    [null],
    [[]],
    [options],
    [undefined, options],
    [null, options],
    [[], options],
    [['-e', 'process.stdout.write("args")'], options],
    [{ ...options, env: Object.create({ CORAL_ALLOWED_VALUE: 'inherited' }) }],
  ];
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    for (const args of forms) {
      const label = `${name}(${args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg))).join(',')})`;
      let result;
      try {
        const file = name === 'fork' ? forkFile : process.execPath;
        if (name === 'fork') {
          const child = cp.fork(file, ...args);
          result = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('message', resolve);
          });
          await new Promise((resolve) => child.on('close', resolve));
        } else if (name.endsWith('Sync')) {
          const value = cp[name](file, ...args);
          result =
            name === 'spawnSync'
              ? {
                  status: value.status,
                  output: value.stdout?.toString(),
                  type: typeof value.stdout,
                  error: value.error?.code,
                }
              : { output: value.toString(), type: typeof value };
        } else if (name === 'execFile') {
          result = await new Promise((resolve, reject) => {
            const child = cp.execFile(file, ...args, (error, stdout) =>
              error ? reject(error) : resolve({ output: stdout.toString(), type: typeof stdout }),
            );
            child.stdin.end(input);
          });
        } else {
          const child = cp.spawn(file, ...args);
          let output = '';
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          child.stdin.end(input);
          result = await new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (status) => resolve({ output, status }));
          });
        }
      } catch (error) {
        result = { error: error.code };
      }
      assert.equal(result.error, undefined, label);
      if ('status' in result) assert.equal(result.status, 0, label);
      results.push([label, result]);
    }
  }
  const command = `"${process.execPath}" -e "process.stdout.write('kept')"`;
  for (const name of ['exec', 'execSync']) {
    for (const args of [[], [undefined], [null], [options]]) {
      const value =
        name === 'execSync' ? cp.execSync(command, ...args) : await callback((done) => cp.exec(command, ...args, done));
      results.push([name, args.length, { output: value.toString(), type: typeof value }]);
    }
  }
  return results;
}

async function filesystem() {
  const results = [];
  const file = path.join(root, 'allowed');
  for (const convert of [(p) => p, (p) => Buffer.from(p), (p) => pathToFileURL(p)]) {
    const value = convert(file);
    fs.writeFileSync(value, 'sync');
    fs.appendFileSync(value, '+');
    results.push(fs.readFileSync(value, 'utf8'));
    await callback((done) => fs.writeFile(value, 'callback', done));
    await callback((done) => fs.appendFile(value, '+', done));
    results.push(await callback((done) => fs.readFile(value, 'utf8', done)));
    await fs.promises.writeFile(value, 'promise');
    await fs.promises.appendFile(value, '+');
    results.push(await fs.promises.readFile(value, 'utf8'));
  }
  const handle = await fs.promises.open(file, 'w+');
  try {
    await fs.promises.writeFile(handle, 'handle');
    await fs.promises.appendFile(handle, '+');
    results.push(fs.readFileSync(file, 'utf8'));
    results.push(await fs.promises.readFile(handle, { encoding: 'utf8', flag: 'w' }));
  } finally {
    await handle.close();
  }
  const fd = fs.openSync(file, 'w+');
  try {
    fs.writeFileSync(fd, 'descriptor');
    fs.appendFileSync(fd, '+');
    await callback((done) => fs.writeFile(fd, '+callback', done));
    await callback((done) => fs.appendFile(fd, '+', done));
    results.push(fs.readFileSync(file, 'utf8'));
    results.push(fs.readFileSync(fd, { encoding: 'utf8', flag: 'w' }));
    results.push(await callback((done) => fs.readFile(fd, { encoding: 'utf8', flag: 'w' }, done)));
  } finally {
    fs.closeSync(fd);
  }
  for (const ignoredPath of [null, path.join(protectedRoot, 'ignored')]) {
    const outputFd = fs.openSync(file, 'w');
    const output = fs.createWriteStream(ignoredPath, { fd: outputFd });
    output.end('stream');
    await finished(output);
    const inputFd = fs.openSync(file, 'r');
    const input = fs.createReadStream(ignoredPath, { fd: inputFd, flags: 'w' });
    let text = '';
    for await (const chunk of input) text += chunk;
    results.push(text);
  }
  return results;
}

async function resolutionErrors() {
  const denied = path.join(root, 'denied');
  const loop = path.join(root, 'loop');
  const source = path.join(root, 'rename-source');
  fs.mkdirSync(denied, { recursive: true });
  if (!fs.existsSync(source)) fs.writeFileSync(source, 'source');
  try {
    fs.symlinkSync('loop', loop);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  fs.chmodSync(denied, 0);
  const details = (error, channel) => ({
    channel,
    name: error?.name,
    message: error?.message,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
    dest: error?.dest,
  });
  const results = [];
  try {
    for (const [code, target] of [
      ['EACCES', path.join(denied, 'file')],
      ['ELOOP', path.join(loop, 'file')],
    ]) {
      for (const [name, args] of [
        ['writeFile', [target, 'data']],
        ['open', [target, 'w']],
        ['rename', [source, target]],
      ]) {
        let sync;
        try {
          fs[name + 'Sync'](...args);
        } catch (error) {
          sync = details(error, 'throw');
        }
        assert.equal(sync?.code, code, `${name}Sync native error`);
        results.push(sync);
        const callbackResult = await new Promise((resolve) => {
          let returned = false;
          try {
            fs[name](...args, (error) => resolve({ ...details(error, 'callback'), returned }));
            returned = true;
          } catch (error) {
            resolve({ ...details(error, 'throw'), returned });
          }
        });
        results.push(callbackResult);
        let promiseResult;
        try {
          const pending = fs.promises[name](...args);
          promiseResult = await pending.then(
            () => ({ channel: 'fulfilled' }),
            (error) => details(error, 'rejection'),
          );
        } catch (error) {
          promiseResult = details(error, 'throw');
        }
        results.push(promiseResult);
      }
    }
  } finally {
    fs.chmodSync(denied, 0o700);
  }
  return results;
}

(async () => {
  try {
    const run = { children, filesystem, errors: resolutionErrors }[process.argv[2]];
    const before = await run();
    require(process.argv[3])({ root: protectedRoot, reports });
    const after = await run();
    assert.deepEqual(after, before);
    assert.deepEqual(fs.readdirSync(reports), []);
    process.stdout.write('transparent');
  } finally {
    remove(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
