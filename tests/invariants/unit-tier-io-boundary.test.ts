/*
The unit tier must stay runnable under a filesystem sandbox, which denies `bind()` on unix domain sockets.
A test that binds one is an integration test by nature, so it belongs under tests/integration (vitest/integration.ts,
pool: forks / singleFork) — where the whole tier is now gated in CI — not in tests/unit or tests/invariants.

Binding an ephemeral TCP port (`listen(0, '127.0.0.1', …)`) is allowed: a sandbox permits it, and several unit
tests legitimately use it to exercise an HTTP surface. The distinction this guard draws is therefore the first
argument to `listen` — a port number is fine, a filesystem path is not.

Relocated precedents guarded here (all previously failed a sandboxed run with `listen EPERM`):
- transport/ipc/{bind-socket,client,handoff,server,subscription-carriage,subscription-primitive}.test.ts
- transport/http/server.test.ts, transport/{coral-setup-error-parity,http-ipc-parity}.test.ts
- coordinator/startup-ordering.test.ts
*/
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNIT_TIER_ROOTS = ['tests/unit', 'tests/invariants'];

function testFilesUnder(root: string): string[] {
  const absolute = resolve(REPO_ROOT, root);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.test.ts')) {
        found.push(path);
      }
    }
  };
  walk(absolute);
  return found;
}

/** `listen(<path>, …)` binds a unix socket; `listen(<port>, …)` binds TCP and is permitted. */
function unixSocketListenLines(filePath: string): number[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'listen' &&
      node.arguments.length > 0 &&
      !ts.isNumericLiteral(node.arguments[0])
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return lines;
}

describe('unit tier I/O boundary', () => {
  it('binds no unix domain socket in tests/unit or tests/invariants', () => {
    const offenders = UNIT_TIER_ROOTS.flatMap((root) =>
      testFilesUnder(root).flatMap((filePath) =>
        unixSocketListenLines(filePath).map((line) => `${relative(REPO_ROOT, filePath)}:${line}`),
      ),
    );

    expect(offenders).toEqual([]);
  });
});
