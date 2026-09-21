import { readFileSync, readdirSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { operatorFacingShutdownObligation } from '#src/transport/http/backend/status.js';
import { shutdownIncidentUndischarged } from '#src/coordinator/shutdown.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OWNERSHIP_SCAN_ROOT = 'src';
const SHUTDOWN_PATH = 'src/coordinator/shutdown.ts';
const SHUTDOWN_SETTLEMENT_PATH = 'src/coordinator/shutdown-settlement.ts';
const LIFECYCLE_PATH = 'src/coordinator/lifecycle.ts';
const BACKEND_STATUS_PATH = 'src/transport/http/backend/status.ts';
const PROCESS_EXIT_OBLIGATION_INVENTORY = [
  'recovery coordinator teardown',
  'kb child shutdown',
  'provider operation mutation drain',
  'provider host shutdown',
  'pending launch settlement',
  'app-server handoff quiesce',
  'provider host drain for handoff',
  'process incarnation probe shutdown',
  'lifecycle reactor dispose',
  'store epoch sweep cancellation',
] as const;
const DERIVED_REMAINDER_OBLIGATIONS: Readonly<Record<string, string>> = {
  'child termination': 'childTerminationRemainder',
};
// A dynamic label's template head text proves only that the prefix matches — not that
// `operatorFacingShutdownObligation` round-trips the numeral the producer actually emits, which is the hole
// that let `[2-9][0-9]*` reject every occurrence with a leading 1. Every prefix accepted below must carry a
// matching case in `dynamicShutdownLabelOrdinalViolations`.
const DYNAMIC_SHUTDOWN_LABEL_PREFIXES = ['stream response close ', 'provider proxy lifecycle fatal incident'] as const;
// The AST-shape collector in `shutdownLabelProjectionViolations` finds a label only where the enclosing
// object literal carries `remainder` (or the `prepare`/`commit`/`hold` triple) as its own property; a
// producer that spreads that property in from elsewhere falls out of collection, and the vocabulary
// check downstream is vacuously true over an empty set. This canary is collected through the `remainder`
// half of that shape and checked against LIFECYCLE_PATH's own collected labels specifically — not the
// set merged across all three scanned files — so losing this file's contribution cannot be masked by
// another file happening to produce the same label.
const LIFECYCLE_SHUTDOWN_LABEL_INVENTORY = ['backend discovery withdrawal'] as const;
// The other half of the same shape — a `label` alongside the `prepare`/`commit`/`hold` boundary triple,
// with no `remainder` property — had no canary of its own: disabling it left this file's other canary
// (collected through `remainder`) unaffected and the check green. Checked against SHUTDOWN_PATH's own
// collected labels specifically, for the same reason as above.
const SHUTDOWN_BOUNDARY_LABEL_INVENTORY = ['provider control and IPC authority release'] as const;
const SHUTDOWN_ERROR_PROJECTION_NAME_CANARIES = ['StoreResetIncidentReadError', 'RangeError', 'SyntaxError'] as const;
const SHUTDOWN_ERROR_PROJECTION_CODE_CANARY = 'ENOENT';

function parseSource(canonicalPath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(canonicalPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function sourceFile(canonicalPath: string): ts.SourceFile {
  return parseSource(canonicalPath, readFileSync(join(REPO_ROOT, canonicalPath), 'utf8'));
}

function sourceFiles(canonicalDirectory: string): ts.SourceFile[] {
  return readdirSync(join(REPO_ROOT, canonicalDirectory), { withFileTypes: true }).flatMap((entry) => {
    const canonicalPath = `${canonicalDirectory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(canonicalPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [sourceFile(canonicalPath)] : [];
  });
}

function propertyName(property: ts.ObjectLiteralElementLike | ts.TypeElement): string | null {
  if (!('name' in property) || property.name === undefined) return null;
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
}

function propertyAssignment(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
}

function propertyExpression(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = object.properties.find((candidate) => propertyName(candidate) === name);
  if (property === undefined) return undefined;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function remainderThunkBody(initializer: ts.Expression): ts.Expression | null {
  const thunk = unwrapExpression(initializer);
  if (!ts.isArrowFunction(thunk) || thunk.parameters.length !== 0 || ts.isBlock(thunk.body)) return null;
  return unwrapExpression(thunk.body);
}

function ownerLiteral(property: ts.PropertyAssignment | ts.PropertySignature): string | null {
  if (ts.isPropertyAssignment(property)) {
    const initializer = unwrapExpression(property.initializer);
    return ts.isStringLiteral(initializer) ? initializer.text : null;
  }
  return property.type !== undefined && ts.isLiteralTypeNode(property.type) && ts.isStringLiteral(property.type.literal)
    ? property.type.literal.text
    : null;
}

function location(node: ts.Node): string {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `${file.fileName}:${line + 1}`;
}

function processExitInventoryViolations(): string[] {
  const shutdown = sourceFile(SHUTDOWN_PATH);
  const settlement = sourceFile(SHUTDOWN_SETTLEMENT_PATH);
  const expected = new Set<string>(PROCESS_EXIT_OBLIGATION_INVENTORY);
  const found = new Map<string, number>();
  const violations: string[] = [];

  function inspectProcessExitOwner(site: string, initializer: ts.Expression, node: ts.Node): void {
    if (!ts.isObjectLiteralExpression(initializer)) {
      violations.push(`${location(node)} ${site} must declare its remainder owner as an object literal`);
      return;
    }
    const owner = propertyAssignment(initializer, 'owner');
    if (owner === undefined || ownerLiteral(owner) !== 'process-exit') {
      violations.push(`${location(node)} ${site} must assign remainder owner 'process-exit'`);
    }
  }

  function inspectDerivedRemainder(name: string, initializer: ts.Expression, node: ts.Node): void {
    const body = remainderThunkBody(initializer);
    const derivation = DERIVED_REMAINDER_OBLIGATIONS[name];
    if (
      body === null ||
      !ts.isCallExpression(body) ||
      !ts.isIdentifier(body.expression) ||
      body.expression.text !== derivation
    ) {
      violations.push(
        `${location(node)} shutdown obligation '${name}' must derive its remainder through ${derivation}`,
      );
    }
  }

  function visitShutdown(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const label = propertyAssignment(node, 'label');
      const name = label !== undefined && ts.isStringLiteral(label.initializer) ? label.initializer.text : null;
      if (name !== null && (expected.has(name) || name in DERIVED_REMAINDER_OBLIGATIONS)) {
        found.set(name, (found.get(name) ?? 0) + 1);
        const remainder = propertyAssignment(node, 'remainder');
        if (remainder === undefined) {
          violations.push(`${location(node)} shutdown obligation '${name}' must declare a remainder owner`);
        } else if (name in DERIVED_REMAINDER_OBLIGATIONS) {
          inspectDerivedRemainder(name, remainder.initializer, remainder);
        } else {
          const body = remainderThunkBody(remainder.initializer);
          if (body === null) {
            violations.push(
              `${location(remainder)} shutdown obligation '${name}' must declare its remainder as a thunk`,
            );
          } else {
            inspectProcessExitOwner(`shutdown obligation '${name}'`, body, remainder);
          }
        }
      }
    }
    ts.forEachChild(node, visitShutdown);
  }
  visitShutdown(shutdown);

  for (const name of [...expected, ...Object.keys(DERIVED_REMAINDER_OBLIGATIONS)]) {
    const count = found.get(name) ?? 0;
    if (count !== 1) {
      violations.push(
        `${SHUTDOWN_PATH} must contain exactly one ownership-inventory obligation '${name}'; found ${count}`,
      );
    }
  }

  const boundaries: ts.PropertyAssignment[] = [];
  function visitSettlement(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && propertyName(node) === 'boundaryRemainder') boundaries.push(node);
    ts.forEachChild(node, visitSettlement);
  }
  visitSettlement(settlement);
  const [boundary] = boundaries;
  if (boundary === undefined || boundaries.length !== 1) {
    violations.push(
      `${SHUTDOWN_SETTLEMENT_PATH} must contain exactly one boundaryRemainder ownership site; found ${boundaries.length}`,
    );
  } else {
    inspectProcessExitOwner('boundaryRemainder', boundary.initializer, boundary);
  }

  return violations;
}

function remainderPayload(initializer: ts.Expression): ts.Expression {
  return remainderThunkBody(initializer) ?? unwrapExpression(initializer);
}

function ownershipShapeFileViolations(file: ts.SourceFile): string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && propertyName(node) === 'remainder') {
      const payload = remainderPayload(node.initializer);
      if (ts.isObjectLiteralExpression(payload) && propertyAssignment(payload, 'owner') === undefined) {
        violations.push(`${location(node)} remainder must declare an owner`);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node) === 'owner' &&
      ownerLiteral(node) === 'successor-recovery'
    ) {
      if (!ts.isObjectLiteralExpression(node.parent)) {
        violations.push(`${location(node)} successor-recovery owner must belong to an object literal`);
      } else {
        const evidence = propertyAssignment(node.parent, 'evidence');
        const via = propertyAssignment(node.parent, 'via');
        if (via !== undefined) {
          violations.push(`${location(via)} successor-recovery remainder must not use free-form via evidence`);
        }
        const evidenceValue = evidence === undefined ? undefined : unwrapExpression(evidence.initializer);
        if (evidence === undefined || evidenceValue === undefined || !ts.isObjectLiteralExpression(evidenceValue)) {
          violations.push(`${location(node)} successor-recovery remainder must carry typed evidence`);
        } else {
          const kind = propertyAssignment(evidenceValue, 'kind');
          if (kind === undefined || !ts.isStringLiteral(unwrapExpression(kind.initializer))) {
            violations.push(`${location(evidence)} successor-recovery evidence must carry a literal kind`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);

  return violations;
}

function ownershipShapeViolations(): string[] {
  const violations: string[] = sourceFiles(OWNERSHIP_SCAN_ROOT).flatMap(ownershipShapeFileViolations);

  const settlement = sourceFile(SHUTDOWN_SETTLEMENT_PATH);
  const remainder = settlement.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'UndischargedRemainder',
  );
  if (remainder === undefined) {
    violations.push(`${SHUTDOWN_SETTLEMENT_PATH} must declare UndischargedRemainder`);
  } else {
    const declaration = remainder.type.getText(settlement);
    const armCount = ts.isUnionTypeNode(remainder.type) ? remainder.type.types.length : 1;
    if (armCount !== 2) {
      violations.push(`UndischargedRemainder must contain exactly two owner arms; found ${armCount}`);
    }
    if (!/evidence\s*:\s*SuccessorRecoveryEvidence/u.test(declaration)) {
      violations.push('UndischargedRemainder successor-recovery owner must require SuccessorRecoveryEvidence');
    }
    if (/\bvia\b/u.test(declaration)) {
      violations.push('UndischargedRemainder must not admit free-form via evidence');
    }
  }

  return violations;
}

function shutdownLabelProjectionViolations(): string[] {
  const status = sourceFile(BACKEND_STATUS_PATH);
  const statusLabels = new Set<string>();
  const producerLabels = new Set<string>();
  const violations: string[] = [];

  function collectStatusLabels(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'OPERATOR_FACING_SHUTDOWN_LABELS' &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.elements) {
          if (ts.isStringLiteral(element)) statusLabels.add(element.text);
        }
      }
    }
    ts.forEachChild(node, collectStatusLabels);
  }
  collectStatusLabels(status);

  function collectProducedLabels(file: ts.SourceFile, target: Set<string> = producerLabels): void {
    function recordProducedLabel(expression: ts.Expression, site: ts.Node): void {
      const initializer = unwrapExpression(expression);
      if (ts.isStringLiteral(initializer)) {
        target.add(initializer.text);
        return;
      }
      if (ts.isTemplateExpression(initializer)) {
        const prefix = initializer.head.text;
        if ((DYNAMIC_SHUTDOWN_LABEL_PREFIXES as readonly string[]).includes(prefix)) return;
        violations.push(`${location(site)} has an unrecognized dynamic shutdown obligation label`);
        return;
      }
      if (
        ts.isPropertyAccessExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'undischarged' &&
        initializer.name.text === 'label'
      ) {
        return;
      }
      if (!ts.isIdentifier(initializer)) {
        violations.push(`${location(site)} does not declare an enumerable shutdown obligation label`);
        return;
      }
      const identifier = initializer.text;

      let scope: ts.Node | undefined = site.parent;
      while (scope !== undefined && !ts.isFunctionLike(scope)) scope = scope.parent;
      const declarations: ts.Expression[] = [];
      function findDeclaration(candidate: ts.Node): void {
        if (candidate !== scope && ts.isFunctionLike(candidate)) return;
        if (
          ts.isVariableDeclaration(candidate) &&
          ts.isIdentifier(candidate.name) &&
          candidate.name.text === identifier &&
          candidate.initializer !== undefined
        ) {
          declarations.push(candidate.initializer);
        }
        ts.forEachChild(candidate, findDeclaration);
      }
      if (scope !== undefined) findDeclaration(scope);
      if (
        scope !== undefined &&
        scope.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier)
      ) {
        return;
      }
      if (declarations.length !== 1) {
        violations.push(`${location(site)} does not resolve to one enumerable shutdown label`);
        return;
      }
      recordProducedLabel(declarations[0], site);
    }

    function visit(node: ts.Node): void {
      if (ts.isObjectLiteralExpression(node)) {
        const label = propertyExpression(node, 'label');
        const remainder = propertyExpression(node, 'remainder');
        const boundary =
          propertyExpression(node, 'prepare') !== undefined &&
          propertyExpression(node, 'commit') !== undefined &&
          propertyExpression(node, 'hold') !== undefined;
        if (label !== undefined && (remainder !== undefined || boundary)) {
          recordProducedLabel(label, node);
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node) === 'acceptanceFailureLabel' &&
        ts.isStringLiteral(unwrapExpression(node.initializer))
      ) {
        target.add((unwrapExpression(node.initializer) as ts.StringLiteral).text);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  // Collected into their own sets, not the shared `producerLabels`, so the two canaries below prove that
  // *this* file's own scan still finds the label its violation message names — a shared set would still
  // read non-empty after either file's collection broke, as long as the other file's own scan supplied it.
  const shutdownLabels = new Set<string>();
  const lifecycleLabels = new Set<string>();
  collectProducedLabels(sourceFile(SHUTDOWN_PATH), shutdownLabels);
  collectProducedLabels(sourceFile(SHUTDOWN_SETTLEMENT_PATH));
  collectProducedLabels(sourceFile(LIFECYCLE_PATH), lifecycleLabels);
  for (const label of shutdownLabels) producerLabels.add(label);
  for (const label of lifecycleLabels) producerLabels.add(label);

  for (const label of LIFECYCLE_SHUTDOWN_LABEL_INVENTORY) {
    if (!lifecycleLabels.has(label)) {
      violations.push(`${LIFECYCLE_PATH} must contribute shutdown obligation label '${label}'`);
    }
  }

  // `LIFECYCLE_SHUTDOWN_LABEL_INVENTORY`'s canary is collected through the object-literal shape's `remainder`
  // half; this canary is collected through its `prepare`/`commit`/`hold` boundary half, the shape's other
  // half, which otherwise has no canary of its own.
  for (const label of SHUTDOWN_BOUNDARY_LABEL_INVENTORY) {
    if (!shutdownLabels.has(label)) {
      violations.push(`${SHUTDOWN_PATH} must contribute shutdown obligation label '${label}'`);
    }
  }

  for (const label of producerLabels) {
    if (!statusLabels.has(label)) violations.push(`shutdown obligation '${label}' has no structured status identity`);
  }
  return violations;
}

/**
 * Measures, rather than reads, that `operatorFacingShutdownObligation` decodes the exact labels each dynamic
 * producer emits at occurrences that cross a leading-1 digit (10, 19, 100) as well as the un-crossed ones (1,
 * 2, 9, 99) — the boundary `[2-9][0-9]*` got wrong. `stream response close` has no isolated producer function
 * (`` `stream response close ${index + 1}` `` inline in shutdown.ts), so its one arithmetic step is reproduced
 * here directly; the incident label is built through the real `shutdownIncidentUndischarged`.
 */
function dynamicShutdownLabelOrdinalViolations(): string[] {
  const violations: string[] = [];
  const boundaryOrdinals = [1, 2, 9, 10, 19, 99, 100];

  for (const ordinal of boundaryOrdinals) {
    const label = `stream response close ${ordinal}`;
    const obligation = operatorFacingShutdownObligation(label);
    if (obligation === null || obligation.label !== 'stream response close' || obligation.ordinal !== ordinal) {
      violations.push(`shutdown obligation label '${label}' does not round-trip to ordinal ${ordinal}`);
    }
  }

  for (const occurrence of boundaryOrdinals) {
    const { label } = shutdownIncidentUndischarged({
      incident: { kind: 'provider-proxy-lifecycle-fatal', error: new Error('fixture') },
      occurrence,
    });
    const obligation = operatorFacingShutdownObligation(label);
    if (
      obligation === null ||
      obligation.label !== 'provider proxy lifecycle fatal incident' ||
      obligation.occurrence !== occurrence
    ) {
      violations.push(`shutdown obligation label '${label}' does not round-trip to occurrence ${occurrence}`);
    }
  }

  return violations;
}

function shutdownErrorProjectionViolations(): string[] {
  const status = sourceFile(BACKEND_STATUS_PATH);
  const projectedNames = new Set<string>();
  const projectedCodes = new Set<string>();
  const producedNames = new Set<string>();
  const handledCodes = new Set<string>();

  function collectProjection(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === 'OPERATOR_FACING_ERROR_NAMES' ||
        node.name.text === 'OPERATOR_FACING_APPLICATION_ERROR_CODES') &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        const target = node.name.text === 'OPERATOR_FACING_ERROR_NAMES' ? projectedNames : projectedCodes;
        for (const element of initializer.elements) {
          if (ts.isStringLiteral(element)) target.add(element.text);
        }
      }
    }
    ts.forEachChild(node, collectProjection);
  }
  collectProjection(status);

  for (const file of sourceFiles(OWNERSHIP_SCAN_ROOT)) {
    if (file.fileName === BACKEND_STATUS_PATH) continue;
    function visit(node: ts.Node): void {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === 'name'
      ) {
        const assignedName = unwrapExpression(node.right);
        if (ts.isStringLiteral(assignedName)) producedNames.add(assignedName.text);
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /^(?:Aggregate|Range|Type)?Error$/u.test(node.expression.text)
      ) {
        producedNames.add(node.expression.text);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        ts.isIdentifier(node.right) &&
        /^(?:Aggregate|Range|Syntax|Type)?Error$/u.test(node.right.text)
      ) {
        producedNames.add(node.right.text);
      }
      if (
        ts.isStringLiteral(node) &&
        /^(?:ERR_[A-Z0-9_]+|E[A-Z][A-Z0-9_]*)$/u.test(node.text) &&
        node.text !== 'ERROR'
      ) {
        handledCodes.add(node.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  const violations: string[] = [];
  for (const name of producedNames) {
    if (!projectedNames.has(name)) violations.push(`repository error name '${name}' has no structured status identity`);
  }
  for (const code of handledCodes) {
    if (code.startsWith('ERR_')) {
      if (!projectedCodes.has(code)) {
        violations.push(`handled application error code '${code}' has no structured status identity`);
      }
    } else if (!(code in osConstants.errno)) {
      violations.push(`handled system error code '${code}' is absent from node:os.constants.errno`);
    }
  }
  for (const name of SHUTDOWN_ERROR_PROJECTION_NAME_CANARIES) {
    if (!producedNames.has(name)) {
      violations.push(`shutdown error projection lost its '${name}' produced-name collection canary`);
    }
  }
  if (!handledCodes.has(SHUTDOWN_ERROR_PROJECTION_CODE_CANARY)) {
    violations.push(
      `shutdown error projection lost its '${SHUTDOWN_ERROR_PROJECTION_CODE_CANARY}' handled-code collection canary`,
    );
  }
  return violations;
}

describe('shutdown remainder ownership inventory', () => {
  it('keeps every migrated obligation and the authority-release boundary assigned to process exit', () => {
    expect(processExitInventoryViolations()).toEqual([]);
  });

  it('rejects ownerless production state and untyped successor-recovery evidence across src', () => {
    expect(ownershipShapeViolations()).toEqual([]);
  });

  it('maps every shutdown remainder label this build produces to a structured status identity', () => {
    expect(shutdownLabelProjectionViolations()).toEqual([]);
  });

  it('round-trips every dynamic shutdown obligation label at its leading-1-boundary occurrences', () => {
    expect(dynamicShutdownLabelOrdinalViolations()).toEqual([]);
  });

  it('maps every repository error name and handled system code to a structured status identity', () => {
    expect(shutdownErrorProjectionViolations()).toEqual([]);
  });
});
