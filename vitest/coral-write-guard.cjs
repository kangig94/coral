const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const cp = require('node:child_process');
const threads = require('node:worker_threads');

const key = Symbol.for('coral.test.writeGuard');

function install(config) {
  if (globalThis[key]) return globalThis[key];
  const append = fs.appendFileSync.bind(fs);
  const root = path.resolve(config.root);
  function canonical(value, depth = 0) {
    if (depth > 40) return;
    let current = path.parse(value).root;
    for (const part of value.slice(current.length).split(path.sep)) {
      if (!part || part === '.') continue;
      if (part === '..') {
        current = path.dirname(current);
        continue;
      }
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          const target = fs.readlinkSync(current);
          current = canonical(path.isAbsolute(target) ? target : path.dirname(current) + path.sep + target, depth + 1);
          if (current === undefined) return;
        }
      } catch (e) {
        if (e.code !== 'ENOENT') return;
      }
    }
    return current;
  }
  const canonicalRoot = canonical(root);
  let testFile = config.testFile;
  const within = (candidate, parent) =>
    candidate === parent || candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  function check(value, operation, follow = true, subtree = false) {
    if (typeof value !== 'string' && !(value instanceof URL) && !Buffer.isBuffer(value)) return;
    const text = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    const p = path.isAbsolute(text) ? text : process.cwd() + path.sep + text;
    const lexical = path.resolve(p);
    if (!within(lexical, root) && !(subtree && within(root, lexical))) {
      let resolved;
      if (follow) resolved = canonical(p);
      else {
        const parent = canonical(path.dirname(p));
        if (parent !== undefined) resolved = path.join(parent, path.basename(p));
      }
      if (resolved === undefined || canonicalRoot === undefined) return;
      if (!within(resolved, canonicalRoot) && !(subtree && within(canonicalRoot, resolved))) return;
    }
    const error = new Error(
      `Test write into real ~/.coral: ${operation} ${p} (pid ${process.pid}, thread ${threads.threadId}, ${testFile || process.argv.join(' ')})`,
    );
    append(
      path.join(config.reports, `${process.pid}-${threads.threadId}.jsonl`),
      JSON.stringify({
        path: p,
        operation,
        pid: process.pid,
        threadId: threads.threadId,
        testFile,
        argv: process.argv,
        stack: error.stack,
      }) + '\n',
    );
    throw error;
  }
  const writes = {
    writeFile: [0],
    appendFile: [0],
    mkdir: [0],
    mkdtemp: [0],
    rename: [0, 1],
    copyFile: [1],
    cp: [1],
    link: [0, 1],
    symlink: [1],
    unlink: [0],
    rm: [0],
    rmdir: [0],
    truncate: [0],
    chmod: [0],
    chown: [0],
    lchmod: [0],
    lchown: [0],
    utimes: [0],
    lutimes: [0],
    createWriteStream: [0],
  };
  function patch(object, name, indices, operation) {
    const original = object[name];
    if (!original) return;
    object[name] = function (...args) {
      for (const i of indices) {
        if (operation === 'createWriteStream' && args[1]?.fd != null) continue;
        check(
          args[i],
          name,
          !['rename', 'unlink', 'rm', 'rmdir', 'symlink', 'lchmod', 'lchown', 'lutimes'].includes(operation),
          ['rm', 'rmdir', 'rename'].includes(operation) || (operation === 'cp' && args[2]?.recursive === true),
        );
      }
      return Reflect.apply(original, this, args);
    };
  }
  for (const [name, indices] of Object.entries(writes)) {
    patch(fs, name, indices, name);
    patch(fs, name + 'Sync', indices, name);
    patch(fs.promises, name, indices, name);
  }
  const writable = (flags) =>
    typeof flags === 'number'
      ? (flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_APPEND)) !==
        0
      : /[wa+]/.test(flags || 'r');
  for (const [object, name] of [
    [fs, 'open'],
    [fs, 'openSync'],
    [fs.promises, 'open'],
  ]) {
    const original = object[name];
    object[name] = function (...args) {
      if (writable(args[1])) check(args[0], name);
      return Reflect.apply(original, this, args);
    };
  }
  for (const [object, name] of [
    [fs, 'readFile'],
    [fs, 'readFileSync'],
    [fs.promises, 'readFile'],
    [fs, 'createReadStream'],
  ]) {
    const original = object[name];
    object[name] = function (...args) {
      if (!(name === 'createReadStream' && args[1]?.fd != null) && writable(args[1]?.flag ?? args[1]?.flags))
        check(args[0], name);
      return Reflect.apply(original, this, args);
    };
  }
  function environment(env) {
    const result = { __proto__: Object.getPrototypeOf(env), ...env };
    const preload = `--require=${JSON.stringify(__filename)}`;
    if (!(result.NODE_OPTIONS || '').includes(preload))
      result.NODE_OPTIONS = `${result.NODE_OPTIONS || ''} ${preload}`.trim();
    result.CORAL_TEST_WRITE_GUARD = JSON.stringify({ ...config, testFile });
    return result;
  }
  // Exact provider environments must retain the test preload at the actual spawn boundary.
  const spawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    const env = Object.fromEntries(
      options.envPairs.map((pair) => {
        const i = pair.indexOf('=');
        return [pair.slice(0, i), pair.slice(i + 1)];
      }),
    );
    return Reflect.apply(spawn, this, [
      { ...options, envPairs: Object.entries(environment(env)).map(([k, v]) => `${k}=${v}`) },
    ]);
  };
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const original = cp[name];
    cp[name] = function (...args) {
      if (name !== 'execSync' && args[1] == null) args[1] = [];
      const i = name === 'execSync' || !Array.isArray(args[1]) ? 1 : 2;
      args[i] = { ...args[i], env: environment(args[i]?.env || process.env) };
      return Reflect.apply(original, this, args);
    };
  }
  const Worker = threads.Worker;
  threads.Worker = class GuardedWorker extends Worker {
    constructor(filename, options = {}) {
      const env = options.env === threads.SHARE_ENV ? threads.SHARE_ENV : environment(options.env ?? process.env);
      if (env === threads.SHARE_ENV)
        process.env.CORAL_TEST_WRITE_GUARD = environment(process.env).CORAL_TEST_WRITE_GUARD;
      super(filename, {
        ...options,
        env,
        execArgv: [...(options.execArgv ?? process.execArgv), '--require', __filename],
      });
    }
  };
  syncBuiltinESMExports();
  const state = {
    setTestFile(value) {
      testFile = value;
    },
  };
  globalThis[key] = state;
  return state;
}
module.exports = install;
if (process.env.CORAL_TEST_WRITE_GUARD) install(JSON.parse(process.env.CORAL_TEST_WRITE_GUARD));
