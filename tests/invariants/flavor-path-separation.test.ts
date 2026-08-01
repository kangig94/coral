import { readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { composeCoralPaths } from '#src/infra/path/index.js';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { generationRoot, generationStateRoot } from '#src/infra/path/root.js';
import { storePaths } from '#src/infra/path/store.js';
import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const FLAVOR_SEPARATED_FAMILIES = [
  'store',
  'corpus',
  'coordinator',
  'exports',
  'engine',
  'kbRuntime',
  'projects',
] as const;
const FAMILIES = ['generation', ...FLAVOR_SEPARATED_FAMILIES] as const;
const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const EXPLICIT_BASE_DIR = join(REPO_ROOT, '.ac2-explicit-base');
const PROD_FLAVOR = resolveBuildFlavor({});
const DEV_FLAVOR = resolveBuildFlavor({ CORAL_FLAVOR: 'dev' });
const PATH_CASES = [
  ['prod without baseDir', PROD_FLAVOR, undefined],
  ['dev without baseDir', DEV_FLAVOR, undefined],
  ['prod with baseDir', PROD_FLAVOR, { baseDir: EXPLICIT_BASE_DIR }],
  ['dev with baseDir', DEV_FLAVOR, { baseDir: EXPLICIT_BASE_DIR }],
] as const;

const LEGACY_BASE_SEGMENTS = new Set(['data', 'data-dev', 'run', 'run-dev']);

function staticPathSegments(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, readonly string[]>,
  helperReturns: ReadonlyMap<string, ts.Expression>,
  resolvingHelpers = new Set<string>(),
): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isIdentifier(expression)) return [...(bindings.get(expression.text) ?? [])];
  if (ts.isConditionalExpression(expression)) {
    return [
      ...staticPathSegments(expression.whenTrue, bindings, helperReturns, resolvingHelpers),
      ...staticPathSegments(expression.whenFalse, bindings, helperReturns, resolvingHelpers),
    ];
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return staticPathSegments(expression.expression, bindings, helperReturns, resolvingHelpers);
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const helperName = expression.expression.text;
    const helperReturn = helperReturns.get(helperName);
    if (!helperReturn || resolvingHelpers.has(helperName)) return [];
    const nextHelpers = new Set(resolvingHelpers);
    nextHelpers.add(helperName);
    return staticPathSegments(helperReturn, bindings, helperReturns, nextHelpers);
  }
  return [];
}

function singleReturnExpression(body: ts.ConciseBody | undefined): ts.Expression | undefined {
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body;
  if (body.statements.length !== 1) return undefined;
  const [statement] = body.statements;
  return ts.isReturnStatement(statement) ? statement.expression : undefined;
}

function collectHelperReturns(source: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const helperReturns = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const expression = singleReturnExpression(statement.body);
      if (expression) helperReturns.set(statement.name.text, expression);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
      const expression = singleReturnExpression(declaration.initializer.body);
      if (expression) helperReturns.set(declaration.name.text, expression);
    }
  }
  return helperReturns;
}

function pathJoinBindings(source: ts.SourceFile): { direct: Set<string>; namespaces: Set<string> } {
  const direct = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'node:path' && statement.moduleSpecifier.text !== 'path') continue;

    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.add(clause.namedBindings.name.text);
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === 'join' || importedName === 'resolve') direct.add(element.name.text);
      }
    }
  }

  return { direct, namespaces };
}

function isPathJoin(expression: ts.LeftHandSideExpression, bindings: ReturnType<typeof pathJoinBindings>): boolean {
  if (ts.isIdentifier(expression)) return bindings.direct.has(expression.text);
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text) &&
    (expression.name.text === 'join' || expression.name.text === 'resolve')
  );
}

function isGenerationRootCall(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return isGenerationRootCall(expression.expression);
  }
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'generationRoot'
  );
}

function legacyBaseConsumers(): string[] {
  const violations: string[] = [];

  for (const filePath of listProductionSourceFiles(SRC_ROOT)) {
    const relativePath = toCanonicalSrcPath(REPO_ROOT, filePath);

    const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
    const bindings = pathJoinBindings(source);
    const helperReturns = collectHelperReturns(source);
    const staticBindings = new Map<string, readonly string[]>();

    const collectBindings = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const segments = staticPathSegments(node.initializer, staticBindings, helperReturns);
        if (segments.length > 0) staticBindings.set(node.name.text, segments);
      }
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(source);

    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isPathJoin(node.expression, bindings) && node.arguments.length > 1) {
        const resolvesLegacySegment = node.arguments
          .slice(1)
          .flatMap((argument) => staticPathSegments(argument, staticBindings, helperReturns))
          .some((segment) => LEGACY_BASE_SEGMENTS.has(segment));
        if (resolvesLegacySegment && !isGenerationRootCall(node.arguments[0])) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${relativePath}:${line} ${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }

  return violations.sort();
}

function allLeafPaths(record: Record<string, unknown>, prefix = ''): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(record)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push({ key, value: v });
    else if (v && typeof v === 'object') out.push(...allLeafPaths(v as Record<string, unknown>, key));
  }
  return out;
}

describe('flavor path separation', () => {
  const prod = composeCoralPaths(PROD_FLAVOR);
  const dev = composeCoralPaths(DEV_FLAVOR);

  it('flavor-bound path bundle exposes exactly the declared families', () => {
    expect(Object.keys(prod).sort()).toEqual([...FAMILIES].sort());
    expect(Object.keys(dev).sort()).toEqual([...FAMILIES].sort());
  });

  it('does not expose dormant legacy equipment content as a live path family', () => {
    expect(prod).not.toHaveProperty('equipment');
    expect(dev).not.toHaveProperty('equipment');
  });

  it.each(FLAVOR_SEPARATED_FAMILIES)('%s family has distinct prod vs dev paths', (family) => {
    const prodLeaves = allLeafPaths(prod[family] as unknown as Record<string, unknown>);
    const devLeaves = allLeafPaths(dev[family] as unknown as Record<string, unknown>);
    expect(prodLeaves.length).toBeGreaterThan(0);
    expect(devLeaves.length).toBe(prodLeaves.length);
    const prodMap = new Map(prodLeaves.map((l) => [l.key, l.value]));
    const devMap = new Map(devLeaves.map((l) => [l.key, l.value]));
    for (const key of prodMap.keys()) {
      const prodVal = prodMap.get(key)!;
      const devVal = devMap.get(key)!;
      expect(devVal).not.toBe(prodVal);
      // Neither is a prefix of the other
      expect(devVal.startsWith(prodVal + '/')).toBe(false);
      expect(prodVal.startsWith(devVal + '/')).toBe(false);
    }
  });

  it('expected segment tokens appear in dev paths', () => {
    expect(dev.generation.dataRoot).toContain('gen2/data-dev');
    expect(dev.generation.legacyDataRoot).toContain('.coral/data-dev');
    expect(dev.store.dbDir).toContain('data-dev/store');
    expect(dev.corpus.kbRoot).toContain('kb-dev');
    expect(dev.coordinator.runDir).toContain('run-dev');
    expect(dev.exports.jobsRoot).toContain('exports-dev/jobs');
    expect(dev.engine.engineRoot).toContain('data-dev/engines');
    expect(dev.projects.root).toContain('projects-dev');
    expect(prod.projects.root).not.toContain('projects-dev');
    expect(kbRuntimePaths(DEV_FLAVOR).root).toContain('data-dev/kb');
    expect(kbRuntimePaths(DEV_FLAVOR).root).not.toContain('data/kb-dev');
    expect(kbRuntimePaths(PROD_FLAVOR).root).toContain('data/kb');
  });

  it.each(PATH_CASES)('%s puts every moved live family under gen2', (_label, flavor, opts) => {
    const stateRoot = generationStateRoot(flavor, opts);
    const runDir = coordinatorPaths(flavor, {}, opts).runDir;
    const movedRoots = [
      storePaths(flavor, opts).dbDir,
      kbRuntimePaths(flavor, opts).root,
      enginePaths(flavor, opts).engineRoot,
      runDir,
    ];

    expect(generationRoot(opts).split(sep).at(-1)).toBe('gen2');
    expect(movedRoots).toEqual([
      join(stateRoot, 'store'),
      join(stateRoot, 'kb'),
      join(stateRoot, 'engines'),
      join(generationRoot(opts), flavor === 'dev' ? 'run-dev' : 'run'),
    ]);
    for (const root of movedRoots) expect(root.split(sep)).toContain('gen2');
  });

  it.each(PATH_CASES)('%s keeps run and data as non-nested siblings', (_label, flavor, opts) => {
    const root = generationRoot(opts);
    const dataRoot = generationStateRoot(flavor, opts);
    const runDir = coordinatorPaths(flavor, {}, opts).runDir;

    expect(runDir).toBe(join(root, flavor === 'dev' ? 'run-dev' : 'run'));
    expect(dirname(runDir)).toBe(root);
    expect(dirname(dataRoot)).toBe(root);
    expect(runDir.startsWith(`${dataRoot}${sep}`)).toBe(false);
  });

  it.each(PATH_CASES)('%s keeps the markdown vault and projects outside gen2', (_label, flavor, opts) => {
    const paths = composeCoralPaths(flavor, opts);
    const coralRoot = dirname(generationRoot(opts));

    expect(paths.corpus.kbRoot).toBe(join(coralRoot, flavor === 'dev' ? 'kb-dev' : 'kb'));
    expect(paths.projects.root).toBe(join(coralRoot, flavor === 'dev' ? 'projects-dev' : 'projects'));
    expect(paths.corpus.kbRoot.split(sep)).not.toContain('gen2');
    expect(paths.projects.root.split(sep)).not.toContain('gen2');
  });

  it('keeps production consumers from resolving legacy flavor roots', () => {
    expect(legacyBaseConsumers()).toEqual([]);
  });
});
