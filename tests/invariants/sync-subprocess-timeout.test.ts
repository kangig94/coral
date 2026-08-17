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
// Scope is direct calls to the `node:child_process` primitives, including through a namespace import. A call
// routed through a port or an injected host (`processPort.execSync`, `host.execFileSync`) is that port's
// contract, not this one.
//
// That exclusion is only honest if the port actually holds the bound, and for a while it did not:
// `runtime/real.ts` forwarded `timeout: execOptions.timeout` from an optional field, so omission meant
// unbounded, and this comment named a successor that had never accepted the obligation. `execSync` there now
// defaults it the way it has always defaulted `maxBuffer`.

import { readFileSync, readdirSync } from 'node:fs';
import type { FrontmatterMergeDriverHost } from '#src/kb/curate/frontmatter-merge-driver.js';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

const SYNC_SUBPROCESS_PRIMITIVES = new Set(['execFileSync', 'execSync', 'spawnSync']);

/**
 * Call sites that forward an options value they did not author, so there is no literal to require. Each entry
 * asserts that some *other* module supplies the bound, which is a claim this scan cannot check on its own —
 * so an entry is only as good as the type it points at, and must be pinned by a test that fails when that
 * type changes.
 *
 * The one entry here was false when written. `cli/commands/kb.ts` forwards into `FrontmatterMergeDriverHost`,
 * whose `execFileSync` typed its options as `{ stdio: 'ignore' }` — a closed type that could not carry a
 * timeout — so the caller credited with owning the bound was statically forbidden from supplying one, and
 * `git merge-file` ran unbounded while this test reported the file compliant. It is true now because that
 * host type requires `timeout`, and `pins the type that makes the one allowlist entry true` fails if it stops
 * requiring it. Check the forwarding caller's *type*, not its prose.
 */
const FORWARDING_ALLOWLIST = new Map<string, string>([
  [
    'src/cli/commands/kb.ts',
    'Adapter for `FrontmatterMergeDriverHost`, whose `execFileSync` options type *requires* `timeout: number` ' +
      '— so every caller must supply one and the forward cannot be unbounded. Pinned by the type assertion below.',
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

type ChildProcessBindings = Readonly<{
  /** Local names bound directly to a primitive: `import { execFileSync }`, or aliased. */
  direct: ReadonlySet<string>;
  /** Namespace names: `import * as cp` — a call is then `cp.execFileSync(...)`. */
  namespaces: ReadonlySet<string>;
}>;

/**
 * How this file reaches the primitives. Both forms are recognised because only recognising named imports made
 * a namespace import invisible to the scan *and* to the vacuity guard below, which used to compute its file
 * list with this same function — one blind spot, counted twice, agreeing with itself.
 *
 * A method on some other object (`processPort.execSync`, `host.execFileSync`) is deliberately not a binding:
 * that call's bound is its port's contract, not this scan's.
 */
function childProcessImports(sourceFile: ts.SourceFile): ChildProcessBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'node:child_process') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const original = element.propertyName?.text ?? element.name.text;
      if (SYNC_SUBPROCESS_PRIMITIVES.has(original)) direct.add(element.name.text);
    }
  }
  return { direct, namespaces };
}

/** The primitive a call expression invokes, or null when it is not one of ours. */
function calleeName(node: ts.CallExpression, bindings: ChildProcessBindings): string | null {
  if (ts.isIdentifier(node.expression)) {
    return bindings.direct.has(node.expression.text) ? node.expression.text : null;
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    bindings.namespaces.has(node.expression.expression.text) &&
    SYNC_SUBPROCESS_PRIMITIVES.has(node.expression.name.text)
  ) {
    return node.expression.name.text;
  }
  return null;
}

/**
 * Whether an options object states a bound — not merely whether it mentions one.
 *
 * `timeout: undefined` and `timeout: 0` both name the property and neither is a bound: Node treats both as
 * "no timeout". A name-only check accepted them, which mattered concretely, because `runtime/real.ts` writes
 * `timeout: execOptions.timeout` from an optional field and would have passed this scan on the spelling while
 * being unbounded whenever its caller omitted one.
 *
 * A spread is resolved against the file's own option constants, so `{ ...PROBE_EXEC_OPTIONS, env }` — the
 * shape `darwin-signal-authority`'s recorded `TZ=UTC` partial needs — is bounded if the spread source is.
 */
function statesTimeout(
  node: ts.ObjectLiteralExpression,
  constants: ReadonlyMap<string, ts.ObjectLiteralExpression>,
): boolean {
  return node.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) {
      if (!ts.isIdentifier(property.expression)) return false;
      const spread = constants.get(property.expression.text);
      return spread !== undefined && statesTimeout(spread, constants);
    }
    const name = property.name;
    if (name === undefined) return false;
    if (!((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'timeout')) return false;
    if (!ts.isPropertyAssignment(property)) return true;
    const value = property.initializer;
    if (ts.isIdentifier(value) && value.text === 'undefined') return false;
    return !(ts.isNumericLiteral(value) && Number(value.text) === 0);
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
  const bindings = childProcessImports(sourceFile);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];

  const constants = optionsConstants(sourceFile);
  const found: Unbounded[] = [];

  const visit = (node: ts.Node): void => {
    const callee = ts.isCallExpression(node) ? calleeName(node, bindings) : null;
    if (ts.isCallExpression(node) && callee !== null) {
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
        if (!statesTimeout(options, constants)) {
          found.push({ file, line, callee, reason: 'inline options state no timeout' });
        }
      } else if (ts.isIdentifier(options)) {
        const resolved = constants.get(options.text);
        if (resolved === undefined) {
          if (!FORWARDING_ALLOWLIST.has(file)) {
            found.push({ file, line, callee, reason: `options \`${options.text}\` is forwarded, not authored here` });
          }
        } else if (!statesTimeout(resolved, constants)) {
          found.push({ file, line, callee, reason: `options constant \`${options.text}\` states no timeout` });
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
    // The oracle here is TEXT, not the AST detector, and that is the whole point. An earlier revision filtered
    // with `childProcessImports` — the same function the scan uses — so a file the detector could not see
    // (a namespace import, say) vanished from the scan and from this guard at the same moment, and both stayed
    // green. A guard that shares the blind spot it exists to detect is not a guard.
    // Both halves are needed. The module specifier alone over-matches — `transport/ipc/ensure.ts` imports the
    // asynchronous `spawn`, which this invariant has no claim on — and a primitive name alone would match
    // prose. Together they are still pure text, which is what keeps the oracle independent of the detector.
    const importers = listSourceFiles(SRC_ROOT)
      .filter((filePath) => {
        const source = readFileSync(filePath, 'utf-8');
        return (
          source.includes("'node:child_process'") && [...SYNC_SUBPROCESS_PRIMITIVES].some((n) => source.includes(n))
        );
      })
      .map(canonicalSrcPath)
      .sort();

    expect(importers, 'every file importing the primitives must be one the detector can see').toEqual([
      'src/cli/commands/kb.ts',
      'src/infra/env-sanitize.ts',
      'src/infra/node-process.ts',
      'src/infra/project-source.ts',
      'src/runtime/real.ts',
    ]);

    // And the detector must actually recognise each of them, which is the half the text oracle cannot prove.
    for (const file of importers) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf-8');
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const { direct, namespaces } = childProcessImports(sourceFile);
      expect(
        direct.size + namespaces.size,
        `${file} imports the primitives but the detector sees none`,
      ).toBeGreaterThan(0);
    }
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
    // Named but not stated: Node treats both as no timeout.
    ['an explicitly undefined timeout', `execSync('ls', { timeout: undefined });`],
    ['a zero timeout', `execSync('ls', { timeout: 0 });`],
    ['a spread whose source states no timeout', `const BASE = { encoding: 'utf8' };\nexecSync('ls', { ...BASE });`],
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
    // The shape `darwin-signal-authority`'s recorded TZ=UTC partial needs.
    [
      'a spread of a bounded constant, extended',
      `const BASE = { encoding: 'utf8', timeout: 2_000 } as const;\nexecFileSync('ps', [], { ...BASE, env: { TZ: 'UTC' } });`,
    ],
  ])('accepts %s', (_label, body) => {
    expect(fixture(body)).toEqual([]);
  });

  it('pins the type that makes the one allowlist entry true', () => {
    // The allowlist credits `cli/commands/kb.ts` with forwarding a bound its caller must supply. That is only
    // true while the host type *requires* `timeout`. When it did not — it was `{ stdio: 'ignore' }`, a closed
    // type that could not carry one — the entry was false and this invariant certified an unbounded
    // `git merge-file` as compliant. Loosening it back must fail here, not silently re-open the exemption.
    type Options = Parameters<FrontmatterMergeDriverHost['execFileSync']>[2];
    const bounded: Options = { stdio: 'ignore', timeout: 2_000 };
    expect(bounded.timeout).toBeTypeOf('number');

    // @ts-expect-error `timeout` is required; if this stops erroring, the allowlist entry has become false.
    const unbounded: Options = { stdio: 'ignore' };
    expect(unbounded).toBeDefined();
  });

  it('sees a namespace import, which a named-import-only detector missed entirely', () => {
    expect(
      unboundedCallsInSource(
        'src/fixture.ts',
        [`import * as cp from 'node:child_process';`, `cp.execFileSync('git', ['remote'], { encoding: 'utf8' });`].join(
          '\n',
        ),
      ),
    ).toHaveLength(1);
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
