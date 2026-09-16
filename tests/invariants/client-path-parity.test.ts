import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { storePaths } from '#src/infra/path/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { resolveCurrentStoreEpoch, storeEpochHookSource } from '#src/store/epoch.js';
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { resolveCurrentStoreDbPath } from '../../clients/hooks/lib/store-epoch.mjs';

const REPO_ROOT = process.cwd();
const HOME_DIR = join(REPO_ROOT, '.client-path-parity-home');
const STATE_ROOT = join(HOME_DIR, '.coral');
const FLAVORS = ['prod', 'dev'] as const;

type MirrorValue = string | boolean;

function evaluateMirrorExpression(expression: ts.Expression, scope: ReadonlyMap<string, MirrorValue>): MirrorValue {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) {
    const value = scope.get(expression.text);
    if (value !== undefined) return value;
  }
  if (ts.isParenthesizedExpression(expression)) return evaluateMirrorExpression(expression.expression, scope);
  if (ts.isConditionalExpression(expression)) {
    return evaluateMirrorExpression(expression.condition, scope)
      ? evaluateMirrorExpression(expression.whenTrue, scope)
      : evaluateMirrorExpression(expression.whenFalse, scope);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return evaluateMirrorExpression(expression.left, scope) === evaluateMirrorExpression(expression.right, scope);
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'join'
  ) {
    const segments = expression.arguments.map((argument) => evaluateMirrorExpression(argument, scope));
    if (segments.every((segment): segment is string => typeof segment === 'string')) return join(...segments);
  }
  throw new Error(`Unsupported client path expression: ${expression.getText()}`);
}

function loadMirrorFunction<T extends (...args: never[]) => string>(relativePath: string, name: string): T {
  const filePath = join(REPO_ROOT, relativePath);
  const sourceText = readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );

  if (!declaration) throw new Error(`Missing ${name} in ${relativePath}`);

  // Hook entry points execute on import and may consume stdin or exit. Evaluate
  // only the narrow path-expression subset in the exact declaration production calls.
  return ((...args: string[]): string => {
    const scope = new Map<string, MirrorValue>();
    declaration.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) throw new Error(`Unsupported parameter in ${relativePath}`);
      scope.set(parameter.name.text, args[index]);
    });

    for (const statement of declaration.body?.statements ?? []) {
      if (ts.isVariableStatement(statement)) {
        for (const variable of statement.declarationList.declarations) {
          if (!ts.isIdentifier(variable.name) || !variable.initializer) {
            throw new Error(`Unsupported variable declaration in ${relativePath}`);
          }
          scope.set(variable.name.text, evaluateMirrorExpression(variable.initializer, scope));
        }
      }
      if (ts.isReturnStatement(statement) && statement.expression) {
        const value = evaluateMirrorExpression(statement.expression, scope);
        if (typeof value === 'string') return value;
      }
    }

    throw new Error(`Missing string return from ${name} in ${relativePath}`);
  }) as unknown as T;
}

const mirroredStoreDbDir = loadMirrorFunction<(flavor: BuildFlavor, stateRoot: string) => string>(
  'clients/hooks/pre-compact.mjs',
  'storeDbDir',
);
const mirroredStoreDiscardRemediation = loadMirrorFunction<(flavor: BuildFlavor) => string>(
  'clients/hooks/pre-compact.mjs',
  'storeDiscardRemediation',
);
const mirroredCoordinatorRunDir = loadMirrorFunction<(flavor: BuildFlavor, stateRoot: string) => string>(
  'clients/hooks/session-start.mjs',
  'coordinatorRunDir',
);
const mirroredEngineBinaryPath = loadMirrorFunction<
  (id: string, bin: string, flavor: BuildFlavor, stateRoot: string) => string
>('clients/hooks/lib/equip-tools.mjs', 'engineBinaryPath');
const mirroredCoordinatorInfoPath = loadMirrorFunction<(homeDir: string, flavor: BuildFlavor) => string>(
  'clients/skills/statusline/coral-hud.mjs',
  'coralBackendInfoPath',
);

describe('self-contained client path parity', () => {
  it('keeps the hook selector generated from the backend owner', () => {
    expect(readFileSync(join(REPO_ROOT, 'clients/hooks/lib/store-epoch.mjs'), 'utf8')).toBe(storeEpochHookSource());
  });

  it.each(FLAVORS)('matches authoritative %s paths', (flavor) => {
    const opts = { baseDir: STATE_ROOT };
    const store = storePaths(flavor, opts);
    const engine = enginePaths(flavor, opts);
    const coordinator = coordinatorPaths(flavor, opts);

    expect(mirroredStoreDbDir(flavor, STATE_ROOT)).toBe(store.dbDir);

    const runDir = mirroredCoordinatorRunDir(flavor, STATE_ROOT);
    expect(runDir).toBe(coordinator.runDir);
    expect(join(runDir, 'coordinator.log')).toBe(join(coordinator.runDir, 'coordinator.log'));

    expect(mirroredEngineBinaryPath('codebase-memory', 'codebase-memory-mcp', flavor, STATE_ROOT)).toBe(
      join(engine.dataDir('codebase-memory'), 'codebase-memory-mcp'),
    );
    expect(mirroredCoordinatorInfoPath(HOME_DIR, flavor)).toBe(coordinator.infoFile);
  });

  it('selects the highest validated epoch after publication', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'coral-client-epoch-parity-'));
    try {
      const published = join(dbDir, 'epoch-1');
      mkdirSync(published);
      writeFileSync(join(published, '.lock'), '');
      writeFileSync(join(published, 'store.db'), 'published');
      writeFileSync(
        join(published, 'epoch.json'),
        JSON.stringify({
          supersedes: null,
          classification: { kind: 'unavailable' },
          build: {
            version: '0.10.9',
            buildSetId: 'build-set',
            bundleHash: 'bundle-hash',
            flavor: 'prod',
            storeFormatFingerprint: 'store-format',
          },
          publishedAt: '2026-09-15T00:00:00.000Z',
        }),
      );
      symlinkSync('.', join(dbDir, 'epoch-2'));

      expect(resolveCurrentStoreDbPath(dbDir)).toBe(join(published, 'store.db'));
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('does not resolve an unreadable generated-hook store root as absent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'coral-client-epoch-unreadable-'));
    const dbDir = join(parent, 'store');
    mkdirSync(dbDir);
    chmodSync(parent, 0o600);
    try {
      expect(() => resolveCurrentStoreDbPath(dbDir)).toThrowError(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('runs both epoch selectors over the same proof-state corpus', () => {
    const validMetadata = JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable' },
      build: {
        version: '0.10.9',
        buildSetId: 'build-set',
        bundleHash: 'bundle-hash',
        flavor: 'prod',
        storeFormatFingerprint: 'store-format',
      },
      publishedAt: '2026-09-15T00:00:00.000Z',
    });
    const corpus = [
      {
        name: 'absent store',
        expected: null,
        arrange(_dbDir: string) {},
      },
      {
        name: 'legacy flat file',
        expected: null,
        arrange(dbDir: string) {
          writeFileSync(join(dbDir, 'store.db'), 'flat');
        },
      },
      {
        name: 'flat symlink',
        expected: null,
        arrange(dbDir: string) {
          symlinkSync(join(dbDir, '..', 'external-store.db'), join(dbDir, 'store.db'));
        },
      },
      {
        name: 'published epoch above a symlink',
        expected: '1',
        arrange(dbDir: string) {
          const published = join(dbDir, 'epoch-1');
          mkdirSync(published);
          writeFileSync(join(published, '.lock'), '');
          writeFileSync(join(published, 'store.db'), 'published');
          writeFileSync(join(published, 'epoch.json'), validMetadata);
          symlinkSync('.', join(dbDir, 'epoch-2'));
        },
      },
      {
        name: 'regular-file blocker above a published epoch',
        expected: '1',
        arrange(dbDir: string) {
          const published = join(dbDir, 'epoch-1');
          mkdirSync(published);
          writeFileSync(join(published, '.lock'), '');
          writeFileSync(join(published, 'store.db'), 'published');
          writeFileSync(join(published, 'epoch.json'), validMetadata);
          writeFileSync(join(dbDir, 'epoch-2'), 'blocker');
        },
      },
      {
        name: 'missing metadata above a published epoch',
        expected: '1',
        arrange(dbDir: string) {
          for (const epoch of ['1', '2']) {
            mkdirSync(join(dbDir, `epoch-${epoch}`));
            writeFileSync(join(dbDir, `epoch-${epoch}`, 'store.db'), epoch);
          }
          writeFileSync(join(dbDir, 'epoch-1', '.lock'), '');
          writeFileSync(join(dbDir, 'epoch-1', 'epoch.json'), validMetadata);
        },
      },
      {
        name: 'malformed metadata above a published epoch',
        expected: '1',
        arrange(dbDir: string) {
          for (const epoch of ['1', '2']) {
            mkdirSync(join(dbDir, `epoch-${epoch}`));
            writeFileSync(join(dbDir, `epoch-${epoch}`, 'store.db'), epoch);
          }
          writeFileSync(join(dbDir, 'epoch-1', '.lock'), '');
          writeFileSync(join(dbDir, 'epoch-1', 'epoch.json'), validMetadata);
          writeFileSync(join(dbDir, 'epoch-2', 'epoch.json'), '{');
        },
      },
      {
        name: 'oversized valid metadata above a published epoch',
        expected: '1',
        arrange(dbDir: string) {
          for (const epoch of ['1', '2']) {
            mkdirSync(join(dbDir, `epoch-${epoch}`));
            writeFileSync(join(dbDir, `epoch-${epoch}`, 'store.db'), epoch);
          }
          writeFileSync(join(dbDir, 'epoch-1', '.lock'), '');
          writeFileSync(join(dbDir, 'epoch-1', 'epoch.json'), validMetadata);
          writeFileSync(
            join(dbDir, 'epoch-2', 'epoch.json'),
            JSON.stringify({ ...JSON.parse(validMetadata), padding: 'x'.repeat(70_000) }),
          );
        },
      },
      {
        name: 'contained symlink above a published epoch',
        expected: '1',
        arrange(dbDir: string) {
          const published = join(dbDir, 'epoch-1');
          mkdirSync(published);
          writeFileSync(join(published, '.lock'), '');
          writeFileSync(join(published, 'store.db'), 'published');
          writeFileSync(join(published, 'epoch.json'), validMetadata);
          symlinkSync('epoch-1', join(dbDir, 'epoch-2'));
        },
      },
      {
        name: 'epoch above the safe-integer ceiling',
        expected: '123456789012345678901234567890',
        arrange(dbDir: string) {
          const published = join(dbDir, 'epoch-123456789012345678901234567890');
          mkdirSync(published);
          writeFileSync(join(published, '.lock'), '');
          writeFileSync(join(published, 'store.db'), 'published');
          writeFileSync(join(published, 'epoch.json'), validMetadata);
        },
      },
    ];

    for (const fixture of corpus) {
      const dbDir = mkdtempSync(join(tmpdir(), 'coral-client-epoch-corpus-'));
      try {
        fixture.arrange(dbDir);
        const backendEpoch = resolveCurrentStoreEpoch(createRealRuntime('prod').storage, dbDir);
        const backendPath = backendEpoch === null ? null : join(dbDir, `epoch-${backendEpoch}`, 'store.db');
        const expectedPath = fixture.expected === null ? null : join(dbDir, `epoch-${fixture.expected}`, 'store.db');

        expect(backendPath, `backend: ${fixture.name}`).toBe(expectedPath);
        expect(resolveCurrentStoreDbPath(dbDir), `hook: ${fixture.name}`).toBe(expectedPath);
      } finally {
        rmSync(dbDir, { recursive: true, force: true });
      }
    }
  });

  it.each(FLAVORS)('renders the explicit %s pre-compact discard remediation', (flavor) => {
    expect(mirroredStoreDiscardRemediation(flavor)).toBe(
      `To deliberately discard this store, run 'coral-cli backend store-reset discard --target gen2 --flavor ${flavor}', then retry compaction.`,
    );
  });
});
