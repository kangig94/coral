#!/usr/bin/env node
//
// verify-runtime-cutover.mjs — AC13 gate for the Phase 1 runtime cutover.
//
// Walks src/**/*.ts via TypeScript resolver and proves there are zero imports
// resolving to src/execution/runtime.ts or src/shared/runtime-ports.ts, plus
// zero Runtime* compat aliases in src/runtime/ports.ts (without Port suffix).
//
// Usage:  node scripts/verify-runtime-cutover.mjs [commitish]
//         --root <dir>    override the repo root (used by fixture self-test)
//         CORAL_VERIFY_ROOT env var also overrides.
//
// Exit 0 on clean (prints "[verify-runtime-cutover] OK"); exit 1 on violations.
//
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPAT_ALIASES = ['RuntimeTime', 'RuntimeStorage', 'RuntimeProcess', 'RuntimeIds', 'RuntimeEnv'];

function parseArgs(argv) {
  let commitish = null;
  let root = process.env.CORAL_VERIFY_ROOT ?? DEFAULT_ROOT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      index += 1;
      if (index >= argv.length) {
        throw new Error('missing value for --root');
      }
      root = argv[index];
      continue;
    }
    if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (commitish !== null) {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
    commitish = arg;
  }

  return {
    commitish,
    root: normalize(resolve(root)),
  };
}

const { commitish, root: ROOT } = parseArgs(process.argv.slice(2));

const FORBIDDEN = new Set([
  normalize(join(ROOT, 'src/execution/runtime.ts')),
  normalize(join(ROOT, 'src/shared/runtime-ports.ts')),
]);

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield normalize(full);
    }
  }
}

async function buildCurrentTreeSource() {
  const files = [];
  for await (const file of walk(join(ROOT, 'src'))) {
    files.push(file);
  }
  files.sort();
  return {
    files,
    async read(absPath) {
      return readFile(absPath, 'utf-8');
    },
  };
}

function buildCommitSource(targetCommitish) {
  const listed = git(['ls-tree', '-r', '--name-only', targetCommitish, '--', 'src'])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => file.endsWith('.ts'));
  listed.sort();

  const byAbsolutePath = new Map(
    listed.map((relativePath) => [normalize(join(ROOT, relativePath)), relativePath]),
  );

  return {
    files: [...byAbsolutePath.keys()],
    async read(absPath) {
      const relativePath = byAbsolutePath.get(absPath);
      if (!relativePath) {
        throw new Error(`file not found in ${targetCommitish}: ${relative(ROOT, absPath)}`);
      }
      return git(['show', `${targetCommitish}:${relativePath}`]);
    },
  };
}

function collectModuleSpecifiers(file, content) {
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  return specifiers;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }

  let resolved = normalize(resolve(dirname(fromFile), specifier));
  if (resolved.endsWith('.js')) {
    resolved = `${resolved.slice(0, -3)}.ts`;
  } else if (!resolved.endsWith('.ts')) {
    resolved = `${resolved}.ts`;
  }

  return normalize(resolved);
}

async function collectViolations(source) {
  const violations = [];

  for (const file of source.files) {
    const content = await source.read(file);
    for (const specifier of collectModuleSpecifiers(file, content)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved !== null && FORBIDDEN.has(resolved)) {
        violations.push({
          file: relative(ROOT, file),
          specifier,
          resolved: relative(ROOT, resolved),
        });
      }
    }
  }

  violations.sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    if (left.specifier !== right.specifier) return left.specifier.localeCompare(right.specifier);
    return left.resolved.localeCompare(right.resolved);
  });

  return violations;
}

async function collectCompatAliases(source) {
  const portsPath = normalize(join(ROOT, 'src/runtime/ports.ts'));
  const content = await source.read(portsPath);
  return COMPAT_ALIASES.filter((alias) => new RegExp(`\\bexport\\s+type\\s+${alias}\\s*=`).test(content));
}

async function main() {
  const source = commitish === null ? await buildCurrentTreeSource() : buildCommitSource(commitish);
  const [violations, aliases] = await Promise.all([collectViolations(source), collectCompatAliases(source)]);

  if (violations.length > 0 || aliases.length > 0) {
    console.error('[verify-runtime-cutover] VIOLATIONS:');
    for (const violation of violations) {
      console.error(`  ${violation.file}: '${violation.specifier}' -> ${violation.resolved}`);
    }
    if (aliases.length > 0) {
      console.error(`  src/runtime/ports.ts still exports compat aliases: ${aliases.join(', ')}`);
    }
    process.exit(1);
  }

  console.log('[verify-runtime-cutover] OK');
}

main().catch((error) => {
  console.error('[verify-runtime-cutover] error:', error);
  process.exit(2);
});
