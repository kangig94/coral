#!/usr/bin/env node
// Temporary: remove at 0.11.0. Reclaims provider session residue left behind before retention learned to
// discard it — codex forks and claude conversation directories whose session Coral already discarded.
// see docs/todo/provider-session-residue-has-no-owner.md
//
// Usage: node sweep-provider-session-residue.mjs [--apply] [--flavor prod|dev] [--state-root <dir>] [--verbose]
// Without --apply nothing is deleted; the report says what would be.

import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_THREAD_ID = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CONVERSATION_REF = /^[0-9A-Za-z][0-9A-Za-z-]*$/;
const HEADER_LIMIT_BYTES = 1024 * 1024;
const HEADER_CHUNK_BYTES = 64 * 1024;

function parseArgs(argv) {
  const options = { apply: false, flavor: 'prod', stateRoot: join(homedir(), '.coral'), verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--flavor') options.flavor = argv[++index];
    else if (arg === '--state-root') options.stateRoot = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.flavor !== 'prod' && options.flavor !== 'dev') throw new Error('--flavor must be prod or dev');
  return options;
}

/** Every store generation on disk: the flat pre-epoch store and each epoch. Residue predates the current one. */
function storeDatabases(stateRoot, flavor) {
  const storeDir = join(stateRoot, 'gen2', flavor === 'dev' ? 'data-dev' : 'data', 'store');
  const databases = [];
  if (existsSync(join(storeDir, 'store.db'))) databases.push(join(storeDir, 'store.db'));
  for (const name of safeReadDir(storeDir)) {
    if (/^epoch-\d+$/.test(name.name) && existsSync(join(storeDir, name.name, 'store.db'))) {
      databases.push(join(storeDir, name.name, 'store.db'));
    }
  }
  return databases;
}

/** Event bodies are stored as UTF-8 JSON in a BLOB column; other columns are TEXT. */
function columnText(value) {
  return value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value);
}

/**
 * Sessions whose retention completed by actually discarding. A `skipped_protected` completion is a session
 * the user asked to keep, so only `discarded` names a root whose residue is owed deletion.
 */
function discardedRoots(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const discarded = new Set();
    for (const row of db.prepare("SELECT stream_id, body FROM events WHERE type = 'session.retention.discard.completed'").iterate()) {
      try {
        if (JSON.parse(columnText(row.body)).outcome === 'discarded') discarded.add(row.stream_id);
      } catch {
        // An undecodable completion names nothing this script may act on.
      }
    }
    const roots = [];
    for (const row of db.prepare('SELECT session_id, conversation_ref, entry FROM projection_sessions').iterate()) {
      if (!discarded.has(row.session_id) || typeof row.conversation_ref !== 'string') continue;
      let binding;
      try {
        binding = JSON.parse(columnText(row.entry)).binding;
      } catch {
        continue;
      }
      const home = binding?.binding?.profile?.canonicalLocation;
      if (typeof home !== 'string' || (binding.provider !== 'codex' && binding.provider !== 'claude')) continue;
      roots.push({ provider: binding.provider, home, conversationRef: row.conversation_ref });
    }
    return roots;
  } finally {
    db.close();
  }
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readRolloutParent(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const chunks = [];
    const buffer = Buffer.alloc(HEADER_CHUNK_BYTES);
    for (let position = 0; position < HEADER_LIMIT_BYTES; ) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) return undefined;
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const parent = record?.payload?.source?.subagent?.thread_spawn?.parent_thread_id;
        return record?.type === 'session_meta' ? (typeof parent === 'string' && THREAD_ID.test(parent) ? parent : null) : undefined;
      }
      chunks.push(Buffer.from(chunk));
      position += read;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function codexForksByParent(sessionsRoot) {
  const forksByParent = new Map();
  const visit = (directory, depth) => {
    for (const entry of safeReadDir(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) {
        visit(path, depth + 1);
        continue;
      }
      const threadId = entry.isFile() ? ROLLOUT_THREAD_ID.exec(entry.name)?.[1] : undefined;
      if (threadId === undefined) continue;
      const parent = readRolloutParent(path);
      if (typeof parent !== 'string') continue;
      const siblings = forksByParent.get(parent) ?? [];
      siblings.push({ threadId, path });
      forksByParent.set(parent, siblings);
    }
  };
  visit(sessionsRoot, 0);
  return forksByParent;
}

/** Descendants of every root, deepest first; a fork is found through its parent's id, so leaves go first. */
function codexResidue(forksByParent, rootThreadIds) {
  const descendants = [];
  const visited = new Set();
  for (const root of rootThreadIds) {
    if (!THREAD_ID.test(root)) continue;
    const queue = [{ threadId: root, depth: 0 }];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const fork of forksByParent.get(next.threadId) ?? []) {
        if (rootThreadIds.has(fork.threadId) || visited.has(fork.path)) continue;
        visited.add(fork.path);
        descendants.push({ ...fork, depth: next.depth + 1 });
        queue.push({ threadId: fork.threadId, depth: next.depth + 1 });
      }
    }
  }
  return descendants.sort((left, right) => right.depth - left.depth);
}

function discardCodex(forksByParent, descendants, report) {
  const retainedThreads = new Set();
  for (const fork of descendants) {
    if ((forksByParent.get(fork.threadId) ?? []).some((child) => retainedThreads.has(child.threadId))) {
      retainedThreads.add(fork.threadId);
      report.retained.push({ path: fork.path, reason: 'a descendant fork was retained' });
      continue;
    }
    try {
      unlinkSync(fork.path);
      report.deleted += 1;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      retainedThreads.add(fork.threadId);
      report.retained.push({ path: fork.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}

function claudeResidueDirectories(projectsRoot, conversationRef) {
  if (!CONVERSATION_REF.test(conversationRef)) return [];
  const directories = [];
  for (const project of safeReadDir(projectsRoot)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(projectsRoot, project.name);
    // The transcript must already be gone: a surviving one means this conversation was not discarded here.
    if (existsSync(join(projectDir, `${conversationRef}.jsonl`))) continue;
    const directory = join(projectDir, conversationRef);
    try {
      const kind = lstatSync(directory);
      if (kind.isDirectory() && !kind.isSymbolicLink()) directories.push(directory);
    } catch {
      // Absent: nothing to reclaim.
    }
  }
  return directories;
}

function treeFiles(directory) {
  const files = [];
  for (const entry of safeReadDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...treeFiles(path));
    else files.push(path);
  }
  return files;
}

function removeTree(directory, report) {
  let complete = true;
  for (const entry of safeReadDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!removeTree(path, report)) complete = false;
      continue;
    }
    try {
      unlinkSync(path);
      report.deleted += 1;
    } catch (error) {
      report.retained.push({ path, reason: error instanceof Error ? error.message : String(error) });
      complete = false;
    }
  }
  if (!complete) return false;
  try {
    rmdirSync(directory);
    return true;
  } catch (error) {
    report.retained.push({ path: directory, reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function megabytes(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const databases = storeDatabases(options.stateRoot, options.flavor);
  if (databases.length === 0) {
    console.log(`No Coral store found under ${options.stateRoot}; nothing to sweep.`);
    return;
  }

  const roots = [];
  for (const database of databases) {
    try {
      const found = discardedRoots(database);
      roots.push(...found);
      console.log(`store ${database}: ${found.length} discarded sessions`);
    } catch (error) {
      console.log(`store ${database}: unreadable, skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const codexRootsByHome = new Map();
  const claudeRoots = [];
  for (const root of roots) {
    if (root.provider === 'codex') {
      const refs = codexRootsByHome.get(root.home) ?? new Set();
      refs.add(root.conversationRef);
      codexRootsByHome.set(root.home, refs);
    } else {
      claudeRoots.push(root);
    }
  }

  const codex = { files: 0, bytes: 0, deleted: 0, retained: [] };
  for (const [home, refs] of codexRootsByHome) {
    const forksByParent = codexForksByParent(join(home, 'sessions'));
    const descendants = codexResidue(forksByParent, refs);
    codex.files += descendants.length;
    codex.bytes += descendants.reduce((sum, fork) => sum + fileSize(fork.path), 0);
    if (options.verbose) for (const fork of descendants) console.log(`  codex fork ${fork.path}`);
    if (options.apply) discardCodex(forksByParent, descendants, codex);
  }

  const claude = { directories: 0, files: 0, bytes: 0, deleted: 0, retained: [] };
  const seen = new Set();
  for (const root of claudeRoots) {
    for (const directory of claudeResidueDirectories(join(root.home, 'projects'), root.conversationRef)) {
      if (seen.has(directory)) continue;
      seen.add(directory);
      const files = treeFiles(directory);
      claude.directories += 1;
      claude.files += files.length;
      claude.bytes += files.reduce((sum, path) => sum + fileSize(path), 0);
      if (options.verbose) console.log(`  claude dir ${directory}`);
      if (options.apply) removeTree(directory, claude);
    }
  }

  console.log(`codex forks: ${codex.files} files, ${megabytes(codex.bytes)}`);
  console.log(`claude conversation directories: ${claude.directories} (${claude.files} files, ${megabytes(claude.bytes)})`);
  if (!options.apply) {
    console.log('Dry run. Re-run with --apply to delete.');
    return;
  }
  console.log(`deleted: ${codex.deleted} codex files, ${claude.deleted} claude files`);
  const retained = [...codex.retained, ...claude.retained];
  if (retained.length > 0) {
    console.log(`retained ${retained.length}:`);
    for (const { path, reason } of retained.slice(0, 20)) console.log(`  ${path} (${reason})`);
  }
}

main();
