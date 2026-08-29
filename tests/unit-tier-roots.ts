import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../vitest/default.ts', import.meta.url));
const TEST_FILE_GLOB_SUFFIX = '/**/*.test.ts';

function assignedProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
      property.name.text === name,
  );
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression {
  const initializer = assignedProperty(object, name)?.initializer;
  if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) {
    throw new Error(`vitest/default.ts must define ${name} as an object literal`);
  }
  return initializer;
}

function defaultTestIncludes(): string[] {
  const source = ts.createSourceFile(
    DEFAULT_CONFIG_PATH,
    readFileSync(DEFAULT_CONFIG_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const defaultExport = source.statements.find(ts.isExportAssignment)?.expression;
  const config =
    defaultExport !== undefined && ts.isCallExpression(defaultExport) ? defaultExport.arguments[0] : undefined;
  if (config === undefined || !ts.isObjectLiteralExpression(config)) {
    throw new Error('vitest/default.ts must export a defineConfig call with an object literal');
  }

  const test = objectProperty(config, 'test');
  const include = assignedProperty(test, 'include')?.initializer;
  if (include === undefined || !ts.isArrayLiteralExpression(include)) {
    throw new Error('vitest/default.ts test.include must be an array literal');
  }

  return include.elements.map((element) => {
    if (!ts.isStringLiteralLike(element)) {
      throw new Error('vitest/default.ts test.include entries must be string literals');
    }
    return element.text;
  });
}

export const UNIT_TIER_ROOTS = defaultTestIncludes().map((include) => {
  if (!include.endsWith(TEST_FILE_GLOB_SUFFIX)) {
    throw new Error(`vitest/default.ts test.include entry cannot identify a tier root: ${include}`);
  }
  return include.slice(0, -TEST_FILE_GLOB_SUFFIX.length);
});
