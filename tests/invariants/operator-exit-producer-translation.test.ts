import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_ROOT = 'tests/invariants/fixtures/operator-exit-producer-translation';

type NamedFunction = ts.FunctionDeclaration | ts.MethodDeclaration;

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(resolve(REPO_ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true);
}

function parseFixture(name: string): ts.SourceFile {
  const path = `${FIXTURE_ROOT}/${name}.ts.txt`;
  return parseSource(path);
}

function functionName(node: NamedFunction): string | null {
  if (node.name === undefined) return null;
  return node.name.getText(node.getSourceFile()).replace(/^#/u, '');
}

function findFunction(source: ts.SourceFile, name: string, requiredText?: string): NamedFunction {
  let match: NamedFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      match === undefined &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      functionName(node) === name &&
      (requiredText === undefined || node.getText(source).includes(requiredText))
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (match === undefined) throw new Error(`${source.fileName}: expected function ${name}`);
  return match;
}

function descendants(node: ts.Node, includeNestedFunctions = false): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    if (!includeNestedFunctions && child !== node && ts.isFunctionLike(child)) return;
    nodes.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return nodes;
}

function identityObservationTranslationViolations(source: ts.SourceFile): string[] {
  const reap = findFunction(source, 'reapRecordedContainment');
  const identityCatch = descendants(reap, true)
    .filter(ts.isCatchClause)
    .find((clause) => clause.block.getText(source).includes('ContainmentIdentityObservationError'));
  if (identityCatch === undefined) return ['identity-observation failure has no translation catch'];

  const identityBranch = descendants(identityCatch.block, true)
    .filter(ts.isIfStatement)
    .find((statement) => statement.expression.getText(source).includes('ContainmentIdentityObservationError'));
  if (identityBranch === undefined) return ['identity-observation failure has no discriminated translation branch'];

  const branchNodes = descendants(identityBranch.thenStatement, true);
  const returnsDisposition = branchNodes.some((node) => {
    if (!ts.isReturnStatement(node) || node.expression === undefined) return false;
    const result = node.expression.getText(source);
    return result.includes("kind: 'identity-unobservable'") && result.includes('signalDelivered');
  });
  const throws = branchNodes.some(ts.isThrowStatement);
  return returnsDisposition && !throws
    ? []
    : ['identity observation can leave reapRecordedContainment without its signal-delivery disposition'];
}

function rejectionHandlerViolations(handler: ts.Node | undefined, label: string, source: ts.SourceFile): string[] {
  if (handler === undefined) return [`${label} has no rejection handler`];
  const nodes = descendants(handler, true);
  const classifies = nodes.some(
    (node) => ts.isCallExpression(node) && node.expression.getText(source) === 'classifyRejection',
  );
  const throws = nodes.some(ts.isThrowStatement);
  return classifies && !throws ? [] : [`${label} can throw without producer-rejection classification`];
}

function retirementProducerTranslationViolations(source: ts.SourceFile): string[] {
  const start = findFunction(source, 'start', 'invokeProducer');
  const producerTry = descendants(start, true)
    .filter(ts.isTryStatement)
    .find((statement) => statement.tryBlock.getText(source).includes('invokeProducer'));
  const violations = rejectionHandlerViolations(producerTry?.catchClause?.block, 'synchronous producer', source);

  const settlement = descendants(start, true)
    .filter(ts.isCallExpression)
    .find(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'then' &&
        call.expression.expression.getText(source).includes('Promise.resolve(produced)'),
    );
  violations.push(...rejectionHandlerViolations(settlement?.arguments[1], 'asynchronous producer', source));
  return violations;
}

function retirementDispatchViolations(source: ts.SourceFile): string[] {
  return ['attemptRetirement', 'attemptForeignCapsuleRetirement'].flatMap((name) => {
    const attempt = findFunction(source, name);
    const startsClassifiedProducer = descendants(attempt, true)
      .filter(ts.isCallExpression)
      .some(
        (call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === 'start' &&
          call.arguments.some((argument) => argument.getText(source).includes("producerId: 'capsule-retirement'")),
      );
    return startsClassifiedProducer ? [] : [`${name} bypasses classified capsule-retirement dispatch`];
  });
}

describe('operator-exit producers translate non-settlement before the IPC boundary', () => {
  it('returns identity-observation uncertainty from recorded-containment reaping', () => {
    expect(identityObservationTranslationViolations(parseSource('src/infra/process-containment.ts'))).toEqual([]);
  });

  it('classifies synchronous and asynchronous retirement producer throws', () => {
    expect(
      retirementProducerTranslationViolations(
        parseSource('src/coordinator/services/provider-proxy-recovery-policy.ts'),
      ),
    ).toEqual([]);
    expect(retirementDispatchViolations(parseSource('src/coordinator/services/provider-proxy-set/index.ts'))).toEqual(
      [],
    );
  });

  it('rejects a deliberately reintroduced identity-observation throw', () => {
    expect(identityObservationTranslationViolations(parseFixture('reap-identity-throw'))).not.toHaveLength(0);
  });

  it.each(['retirement-sync-throw', 'retirement-async-throw'])(
    'rejects a deliberately reintroduced retirement producer throw in %s',
    (fixture) => {
      expect(retirementProducerTranslationViolations(parseFixture(fixture))).not.toHaveLength(0);
    },
  );
});
