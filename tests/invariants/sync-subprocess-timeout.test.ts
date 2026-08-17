// Synchronous-subprocess timeout invariant — every direct `execFileSync` / `execSync` / `spawnSync` under
// `src/` must pass a `timeout`.
//
// The rule exists because a synchronous subprocess is the one thing in this process that no deadline here can
// interrupt. Every timeout mechanism the codebase owns is asynchronous — `AbortSignal`, monotonic-clock
// polling, budgeted shutdown steps — and none of them preempt a call that blocks the event loop outright. A
// wedged child is therefore not "slow"; it is a process that never continues, on paths that include coordinator
// startup.
//
// It is enforced here rather than left to review because the three sites disagreed for a long time and
// nothing said so. `env-sanitize.ts` bounded its `getconf` from the start; `node-process.ts` shipped three
// unbounded probes; `project-source.ts` shipped an unbounded `git remote get-url` in the v0.6.0 rewrite
// (`618c95d1`) that was still unbounded ten minor versions later, on the coordinator startup path the whole
// time. Nothing failed, because a bounded site does not argue with an unbounded one. A scan does.
//
// What this does NOT assert: that the timeout is honoured. Node implements a synchronous timeout by signalling
// the child and continuing to wait, so a child that blocks or ignores the signal still overruns. The bound is
// best-effort by construction. This test asserts only that every site asks for one, which is the part a scan
// can see.
//
// Scope is direct calls to the `node:child_process` primitives. Calls routed through a port or an injected
// host (`processPort.execSync`, `host.execFileSync`) are that port's contract, not this one — `runtime/real.ts`
// forwards its caller's `timeout`, and requiring a literal there would be wrong.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

const SYNC_SUBPROCESS_PRIMITIVES = new Set(['execFileSync', 'execSync', 'spawnSync']);

/**
 * Call sites that forward an options value they did not author, so there is no literal to require. Each entry
 * is a pass-through adapter whose caller owns the bound. Adding one is a conscious decision: it asserts that
 * the options object genuinely arrives from elsewhere, not that the timeout was inconvenient to add.
 */
const FORWARDING_ALLOWLIST = new Map<string, string>([
  [
    'src/cli/commands/kb.ts',
    'Adapts `execFileSync` into a host object and forwards the caller-supplied options object verbatim.',
  ],
]);

function listSourceFiles(root: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [join(REPO_ROOT, root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        collected.push(absolute);
      }
    }
  }
  return collected;
}

function canonicalSrcPath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

/** Names imported from `node:child_process` in this file, so `host.execFileSync` and look-alikes are ignored. */
function childProcessImports(sourceFile: ts.SourceFile): Set<string> {
  const imported = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'node:child_process') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const original = element.propertyName?.text ?? element.name.text;
      if (SYNC_SUBPROCESS_PRIMITIVES.has(original)) imported.add(element.name.text);
    }
  }
  return imported;
}

function hasTimeoutProperty(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((property) => {
    const name = property.name;
    if (name === undefined) return false;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'timeout';
  });
}

/** Object literals assigned to a `const` at any scope, so a hoisted options constant resolves. */
function optionsConstants(sourceFile: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const constants = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(initializer)) constants.set(node.name.text, initializer);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return constants;
}

type Unbounded = Readonly<{ file: string; line: number; callee: string; reason: string }>;

function unboundedCalls(filePath: string): Unbounded[] {
  return unboundedCallsInSource(canonicalSrcPath(filePath), readFileSync(filePath, 'utf-8'));
}

/**
 * Split from the file read so the fixtures below can drive this exact function. An earlier revision of this
 * test reimplemented the walk inline for its negative cases, which meant the fixtures agreed with a copy of
 * the detector rather than the detector — and the copy kept a bug the real one had already lost.
 */
function unboundedCallsInSource(file: string, source: string): Unbounded[] {
  if (![...SYNC_SUBPROCESS_PRIMITIVES].some((name) => source.includes(name))) return [];

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const primitives = childProcessImports(sourceFile);
  if (primitives.size === 0) return [];

  const constants = optionsConstants(sourceFile);
  const found: Unbounded[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && primitives.has(node.expression.text)) {
      const callee = node.expression.text;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      // Options are always last, but the arity is not fixed: `execFileSync` and `spawnSync` each accept both
      // `(file, args, options)` and `(file, options)`, so indexing a position would flag a legitimate
      // two-argument call as having none. Take the final argument and let its shape say whether it is options
      // at all — an args array or a bare command string means the call passed none.
      const last = node.arguments.at(-1);
      const options =
        last === undefined || ts.isArrayLiteralExpression(last) || ts.isStringLiteralLike(last) ? undefined : last;

      if (options === undefined) {
        found.push({ file, line, callee, reason: 'no options argument, so no timeout' });
      } else if (ts.isObjectLiteralExpression(options)) {
        if (!hasTimeoutProperty(options)) {
          found.push({ file, line, callee, reason: 'inline options without a timeout' });
        }
      } else if (ts.isIdentifier(options)) {
        const resolved = constants.get(options.text);
        if (resolved === undefined) {
          if (!FORWARDING_ALLOWLIST.has(file)) {
            found.push({ file, line, callee, reason: `options \`${options.text}\` is forwarded, not authored here` });
          }
        } else if (!hasTimeoutProperty(resolved)) {
          found.push({ file, line, callee, reason: `options constant \`${options.text}\` has no timeout` });
        }
      } else if (!FORWARDING_ALLOWLIST.has(file)) {
        found.push({ file, line, callee, reason: 'options expression could not be resolved to a timeout' });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

describe('synchronous subprocess timeout invariant', () => {
  it('bounds every direct sync subprocess call under src/', () => {
    const violations = listSourceFiles(SRC_ROOT).flatMap(unboundedCalls);

    expect(
      violations.map((violation) => `${violation.file}:${violation.line} ${violation.callee}() — ${violation.reason}`),
      'a synchronous subprocess blocks the event loop, and no async deadline in this codebase can interrupt it',
    ).toEqual([]);
  });

  it('finds the sites it is meant to protect, so a passing run is not vacuous', () => {
    // Without this, deleting every sync subprocess call — or breaking the import detection — would leave the
    // assertion above green and prove nothing. These are the three direct call sites that exist today.
    const scanned = listSourceFiles(SRC_ROOT).filter((filePath) => {
      const sourceFile = ts.createSourceFile(
        canonicalSrcPath(filePath),
        readFileSync(filePath, 'utf-8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      return childProcessImports(sourceFile).size > 0;
    });

    expect(scanned.map(canonicalSrcPath).sort()).toEqual([
      'src/cli/commands/kb.ts',
      'src/infra/env-sanitize.ts',
      'src/infra/node-process.ts',
      'src/infra/project-source.ts',
      'src/runtime/real.ts',
    ]);
  });

  const fixture = (body: string): Unbounded[] =>
    unboundedCallsInSource(
      'src/fixture.ts',
      `import { execFileSync, execSync, spawnSync } from 'node:child_process';\n${body}\n`,
    );

  it.each([
    ['inline options without a timeout', `execFileSync('git', ['status'], { encoding: 'utf8' });`],
    ['no options argument at all', `execSync('ls');`],
    ['a hoisted options constant without a timeout', `const OPTS = { encoding: 'utf8' };\nspawnSync('ls', [], OPTS);`],
    // Options sit where an args array otherwise would; indexing a fixed position missed this.
    ['the (file, options) overload without a timeout', `execFileSync('git', { encoding: 'utf8' });`],
    // Args but no options at all — the distinction from the overload above is exactly what the shape test
    // draws, and both are violations: a subprocess with no options object has no bound either.
    ['args with no options object', `execFileSync('git', ['status']);`],
  ])('rejects %s', (_label, body) => {
    expect(fixture(body)).toHaveLength(1);
  });

  it.each([
    ['an inline bound', `execFileSync('ps', ['-p', '1'], { encoding: 'utf8', timeout: 2_000 });`],
    // node-process.ts is written this way; a literal-only check would read its bounded probes as unbounded.
    [
      'a hoisted options constant',
      `const OPTS = { encoding: 'utf8', timeout: 2_000 } as const;\nexecFileSync('ps', [], OPTS);`,
    ],
    ['the (file, options) overload', `execFileSync('git', { encoding: 'utf8', timeout: 2_000 });`],
  ])('accepts %s', (_label, body) => {
    expect(fixture(body)).toEqual([]);
  });

  it('ignores a look-alike that is not the node:child_process primitive', () => {
    // `host.execFileSync(...)` and an injected port are that port's contract, not this one.
    expect(
      unboundedCallsInSource(
        'src/fixture.ts',
        [
          `import { execFileSync } from 'node:child_process';`,
          `declare const host: { execFileSync(c: string): void };`,
          `host.execFileSync('git');`,
          `execFileSync('ps', [], { timeout: 1 });`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
