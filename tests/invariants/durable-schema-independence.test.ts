import { readFileSync, readdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE_ROOT = 'tests/invariants/fixtures/durable-schema-independence';
type SchemaKey = `${string}#${string}`;

type SourceUnit = Readonly<{
  path: string;
  source: ts.SourceFile;
}>;

const localSchemaNamesBySource = new WeakMap<ts.SourceFile, ReadonlySet<string>>();
const localConstDeclarationsBySource = new WeakMap<ts.SourceFile, ReadonlyMap<string, ts.VariableDeclaration>>();
const localFunctionsBySource = new WeakMap<ts.SourceFile, ReadonlyMap<string, ts.FunctionDeclaration>>();

const DURABLE_SCHEMA_ROOTS = new Set<SchemaKey>([
  'src/causality/cause-ref.ts#causeRefSchema',
  'src/coordinator/handoff-routing/status.ts#durableHandoffRoutingBasisSchema',
  'src/coordinator/handoff-routing/status.ts#handoffRoutingMutationSchema',
  'src/coordinator/handoff-routing/status.ts#handoffRoutingTransitionSchema',
  'src/coordinator/handoff-routing/status.ts#invalidTargetSummarySchema',
  'src/coordinator/handoff-routing/status.ts#retirementHistoryTruncatedSchema',
  'src/coordinator/handoff-routing/status.ts#validatedTargetSummarySchema',
  'src/coordinator/runtime-components/recovery-component.ts#recoveryQuarantineHealthRowSchema',
  'src/coordinator/services/provider-proxy-set/operator-disposition-store.ts#durableProviderProxySetAcquisitionDispositionRecordSchema',
  'src/coordinator/services/provider-proxy-set/operator-disposition-store.ts#durableProviderProxySetOperatorDispositionFileSchema',
  'src/coordinator/services/provider-proxy-set/operator-disposition-store.ts#durableProviderProxySetOperatorDispositionRecordSchema',
  'src/coordinator/shutdown-abandonment.ts#shutdownAbandonmentStatusSchema',
  'src/discuss/projections.ts#persistedDiscussSnapshotSchema',
  'src/discuss/events.ts#persistedDiscussRuntimeSchema',
  'src/discuss/session-types.ts#discussStateSchema',
  'src/discuss/shell/recovery.ts#discussionResumeContinuationSchema',
  'src/expansion/manifest/schema.ts#persistedDeclarativeEngineManifestSchema',
  'src/infra/backend-discovery.ts#coordinatorDiscoveryRecordSchema',
  'src/infra/plugin-registry.ts#installedPluginsFileSchema',
  'src/infra/persisted-scalar-contracts.ts#persistedNonEmptyStringSchema',
  'src/infra/persisted-scalar-contracts.ts#persistedProcessIncarnationSchema',
  'src/infra/process-containment.ts#recordedProcessIdentitySchema',
  'src/infra/provider-binding-envelope.ts#providerBindingEnvelopeSchema',
  'src/infra/provider-scope.ts#providerScopeSchema',
  'src/infra/shutdown-remainder-record.ts#shutdownRemainderEntrySchema',
  'src/infra/shutdown-remainder-record.ts#shutdownRemainderRecordEnvelopeSchema',
  'src/jobs/discussion-run.ts#discussionRunDescriptorSchema',
  'src/jobs/outcome.ts#externalErrorSchema',
  'src/jobs/outcome.ts#jobDomainProgressSchema',
  'src/jobs/outcome.ts#jobProgressFaultSchema',
  'src/jobs/outcome.ts#terminalOutcomeSchema',
  'src/jobs/phase.ts#jobPhaseSchema',
  'src/jobs/projection-row.ts#projectionJobStoredRowSchema',
  'src/jobs/provider-operation-terminalization.ts#providerHostUnserviceableEvidenceSchema',
  'src/jobs/records.ts#jobKindSchema',
  'src/jobs/runtime-meta.ts#durableCliContainmentStatusSchema',
  'src/jobs/runtime-meta.ts#durableCliProcessRuntimeMetaSchema',
  'src/jobs/runtime-meta.ts#durableCliProcessRuntimeMetaV1Schema',
  'src/jobs/runtime-meta.ts#durableCliProvisionalProcessRuntimeMetaSchema',
  'src/jobs/terminal/result.ts#jobDiagnosticsSchema',
  'src/jobs/terminal/result.ts#jobTerminalRecordedBodySchema',
  'src/kb/capability/contract.ts#kbCapabilityDescriptorSchema',
  'src/kb/capability/contract.ts#kbCapabilityNameSchema',
  'src/kb/curate/conflict-quarantine.ts#quarantineRowSchema',
  'src/kb/curate/discovery-backlog.ts#backlogNoteRowSchema',
  'src/kb/curate/discovery-backlog.ts#backlogRowSchema',
  'src/kb/curate/retry.ts#retryRowSchema',
  'src/kb/curate/state-scheduler.ts#schedulerRowSchema',
  'src/kb/curate/state/store.ts#activeClaimRowSchema',
  'src/kb/state/corpus-state.ts#corpusStateRowSchema',
  'src/kb/curate/state/model.ts#kbEntryIdSchema',
  'src/kb/search/contract.ts#retrievalRoleDescriptorSchema',
  'src/projection-consumers/persistence.ts#consumerCursorMetadataSchema',
  'src/projection-consumers/persistence.ts#corpusConsumerCursorSchema',
  'src/projection-consumers/persistence.ts#journalConsumerCursorSchema',
  'src/provider-proxy/bootstrap-capsule.ts#providerBootstrapCapsuleSchema',
  'src/provider-proxy/handoff-capsule.ts#handoffCapsuleSchema',
  'src/provider-proxy/handoff-capsule.ts#handoffCapsuleV1Schema',
  'src/provider-proxy/handoff-capsule.ts#handoffCapsuleV2Schema',
  'src/provider-proxy/handoff-capsule.ts#handoffCapsuleV3Schema',
  'src/recovery/quarantine.ts#rawRetentionContinuationRowSchema',
  'src/recovery/quarantine.ts#recoveryQuarantineRowSchema',
  'src/providers/artifact-identity.ts#providerArtifactIdentitySchema',
  'src/providers/contracts/binding.ts#providerBindingFailureReasonSchema',
  'src/providers/contracts/binding.ts#accountSubjectSchema',
  'src/providers/contracts/profile.ts#absoluteProfilePathSchema',
  'src/providers/contract.ts#providerInstructionSchema',
  'src/providers/contract.ts#usageSummarySchema',
  'src/providers/claude/request-mapping.ts#claudePersistedContinuitySchema',
  'src/providers/claude/request-prep.ts#claudeBootstrapSignatureSchema',
  'src/providers/codex/request-mapping.ts#codexPersistedContinuitySchema',
  'src/providers/host-admission.ts#providerHostRemediationSchema',
  'src/providers/host-ref-schema.ts#hostRefSchema',
  'src/providers/turn-failure-diagnostic.ts#turnFailureDiagnosticSchema',
  'src/runtime/canonical-work-dir.ts#canonicalWorkDirWireSchema',
  'src/runtime/execution-owner.ts#executionOwnerSchema',
  'src/sessions/continuity.ts#continuityRefSchema',
  'src/sessions/continuity.ts#continuitySnapshotSchema',
  'src/sessions/fault.ts#sessionAdapterUnparseableFaultSchema',
  'src/sessions/fault.ts#sessionInterruptedFaultSchema',
  'src/sessions/fault.ts#sessionProviderFailedFaultSchema',
  'src/sessions/entry.ts#providerSessionSchema',
  'src/sessions/projections.ts#projectionSessionStoredRowSchema',
  'src/sessions/provider-artifact-archive.ts#archiveManifestSchema',
  'src/store/active-store-selection.ts#activeStoreSelectionSchema',
  'src/store/active-store-selection.ts#activeStoreSelectionV1Schema',
  'src/store/active-store-selection.ts#activeStoreTransitionSchema',
  'src/store/envelope.ts#journalEventEnvelopeSchema',
  'src/store/envelope.ts#journalEventInputSchema',
  'src/store/envelope.ts#journalEventRefsSchema',
  'src/store/provider-operation-journal.ts#providerOperationDueEntrySchema',
  'src/store/provider-operation-journal.ts#supersededProcessSchema',
  'src/store/provider-operation-journal.ts#supersededRecordSchema',
  'src/store/provider-operation-record.ts#providerOperationIdentitySchema',
  'src/store/provider-operation-record.ts#providerOperationRecordSchema',
  'src/workflow/plan.ts#workflowPlanSchema',
  'src/workflow/lifecycle.ts#workflowLifecycleSchema',
  'src/workflow/lifecycle.ts#workflowTerminalLifecycleSchema',
]);

const IN_MEMORY_PERSISTENCE_CONTEXT_SCHEMAS = new Set<SchemaKey>([
  'src/cli/commands/expansion.ts#namedExpansionArgsSchema',
  'src/cli/expansion/contract.ts#expansionArgsSchema',
  'src/expansion/rpc-contract.ts#installErrorSchema',
  'src/expansion/rpc-contract.ts#installResultSchema',
  'src/provider-proxy/protocol.ts#proxyOperationStatusNonceSchema',
  'src/transport/rpc/catalog.ts#providerHostEvictResponseSchema',
  'src/transport/rpc/catalog.ts#providerHostInspectResponseSchema',
  'src/transport/rpc/catalog.ts#providerHostListResponseSchema',
  'src/transport/rpc/catalog.ts#providerHostListV2ResponseSchema',
  'src/transport/rpc/catalog.ts#providerProxySetContainBooleanResponseSchema',
  'src/transport/rpc/catalog.ts#providerProxySetContainResponseSchema',
  'src/transport/rpc/catalog.ts#unreadableProviderOperationDiscardResultSchema',
]);

const DURABLE_SCHEMA_FACTORIES = new Set<SchemaKey>([
  'src/coordinator/handoff-routing/status.ts#createHandoffRoutingRecordSchemaRegistry',
  'src/obligation/shutdown-abandonment.ts#createShutdownObligationAbandonmentReceiptParser',
  'src/providers/claude/binding.ts#createClaudeBindingSchema',
  'src/providers/claude/binding.ts#createClaudeCredentialProfileSchema',
  'src/providers/codex/binding.ts#createCodexBindingSchema',
  'src/providers/codex/binding.ts#createCodexCredentialProfileSchema',
]);

const DURABLE_SCHEMA_REGISTRIES = new Set<SchemaKey>([
  'src/discuss/events.ts#discussEventBodySchemas',
  'src/jobs/events.ts#jobsRegistry',
  'src/sessions/events.ts#sessionsRegistry',
  'src/workflow/events.ts#workflowRegistry',
]);

const DURABLE_SCHEMA_COMPONENTS = new Set<SchemaKey>([
  'src/coordinator/services/provider-proxy-set/operator-disposition-store.ts#durableAcquisitionRecoverySubjectSchema',
  'src/discuss/session-types.ts#transcriptMetadataSchema',
  'src/jobs/event-bodies.ts#providerHostRefIdentitySchema',
  'src/provider-proxy/bootstrap-capsule.ts#commonBootstrapCapsuleShape',
  'src/provider-proxy/bootstrap-capsule.ts#durableCanonicalEndpoint',
  'src/store/provider-operation-record.ts#authorizedFields',
  'src/store/provider-operation-record.ts#commonFields',
  'src/store/provider-operation-record.ts#executingFields',
  'src/store/provider-operation-record.ts#preparationEvidenceFields',
  'src/workflow/events.ts#workflowStepDetailsField',
]);

function parseSource(path: string, source: string): SourceUnit {
  return { path, source: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}

function readSourceTree(directory: string): SourceUnit[] {
  return readdirSync(resolve(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return readSourceTree(path);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    return [parseSource(path, readFileSync(resolve(REPO_ROOT, path), 'utf8'))];
  });
}

function readFixture(name: string): SourceUnit {
  const path = `${FIXTURE_ROOT}/${name}.ts`;
  return parseSource(path, readFileSync(resolve(REPO_ROOT, `${path}.txt`), 'utf8'));
}

function schemaKey(path: string, name: string): SchemaKey {
  return `${path}#${name}`;
}

function declarationName(node: ts.VariableDeclaration | ts.FunctionDeclaration): string | null {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

type SchemaImports = Readonly<{
  named: ReadonlyMap<string, SchemaKey>;
  namespaces: ReadonlyMap<string, string>;
}>;

function importedModulePath(unit: SourceUnit, moduleSpecifier: string): string | null {
  if (moduleSpecifier.startsWith('#src/')) {
    return `src/${moduleSpecifier.slice('#src/'.length).replace(/\.js$/u, '.ts')}`;
  }
  if (!moduleSpecifier.startsWith('.')) return null;
  return posix.normalize(posix.join(dirname(unit.path), moduleSpecifier.replace(/\.js$/u, '.ts')));
}

function schemaImports(unit: SourceUnit): SchemaImports {
  const named = new Map<string, SchemaKey>();
  const namespaces = new Map<string, string>();
  for (const statement of unit.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = importedModulePath(unit, statement.moduleSpecifier.text);
    if (target === null) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, target);
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (statement.importClause?.isTypeOnly === true || element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported.endsWith('Schema')) named.set(element.name.text, schemaKey(target, imported));
    }
  }
  return { named, namespaces };
}

function schemaDeclarations(units: readonly SourceUnit[]): ReadonlyMap<SchemaKey, ts.VariableDeclaration> {
  const declarations = new Map<SchemaKey, ts.VariableDeclaration>();
  for (const unit of units) {
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text.endsWith('Schema')) {
        declarations.set(schemaKey(unit.path, node.name.text), node);
      }
      ts.forEachChild(node, visit);
    }
    visit(unit.source);
  }
  return declarations;
}

function localSchemaNames(unit: SourceUnit): ReadonlySet<string> {
  const cached = localSchemaNamesBySource.get(unit.source);
  if (cached !== undefined) return cached;
  const names = new Set([...schemaDeclarations([unit]).keys()].map((key) => key.slice(key.lastIndexOf('#') + 1)));
  localSchemaNamesBySource.set(unit.source, names);
  return names;
}

function localConstDeclarations(unit: SourceUnit): ReadonlyMap<string, ts.VariableDeclaration> {
  const cached = localConstDeclarationsBySource.get(unit.source);
  if (cached !== undefined) return cached;
  const declarations = new Map<string, ts.VariableDeclaration>();
  for (const statement of unit.source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
    }
  }
  localConstDeclarationsBySource.set(unit.source, declarations);
  return declarations;
}

/**
 * Several questions here ask a unit for its functions, and the answer is a walk of the whole unit: over
 * `src/` the repeated walks measured 0.5s of this invariant's 2.6s (10-core Apple M-series,
 * 2026-09-17). A parsed unit never changes, so the walk happens once per source file.
 */
function localFunctions(unit: SourceUnit): ReadonlyMap<string, ts.FunctionDeclaration> {
  const cached = localFunctionsBySource.get(unit.source);
  if (cached !== undefined) return cached;
  const functions = new Map<string, ts.FunctionDeclaration>();
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) {
      const name = declarationName(node);
      if (name !== null) functions.set(name, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(unit.source);
  localFunctionsBySource.set(unit.source, functions);
  return functions;
}

function findVariable(unit: SourceUnit, name: string): ts.VariableDeclaration | null {
  let match: ts.VariableDeclaration | null = null;
  function visit(node: ts.Node): void {
    if (match === null && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(unit.source);
  return match;
}

function referencedSchemas(unit: SourceUnit, node: ts.Node): ReadonlySet<SchemaKey> {
  const imports = schemaImports(unit);
  const localSchemas = localSchemaNames(unit);
  const localConstants = localConstDeclarations(unit);
  const references = new Set<SchemaKey>();
  const visitedConstants = new Set<string>();
  function visit(current: ts.Node): void {
    if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)) {
      const namespacePath = imports.namespaces.get(current.expression.text);
      if (namespacePath !== undefined && current.name.text.endsWith('Schema')) {
        references.add(schemaKey(namespacePath, current.name.text));
        return;
      }
    }
    if (ts.isIdentifier(current)) {
      if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) return;
      if (ts.isPropertyAssignment(current.parent) && current.parent.name === current) return;
      const imported = imports.named.get(current.text);
      if (imported !== undefined) references.add(imported);
      else if (localSchemas.has(current.text)) references.add(schemaKey(unit.path, current.text));
      else if (!visitedConstants.has(current.text)) {
        const declaration = localConstants.get(current.text);
        if (declaration?.initializer !== undefined) {
          visitedConstants.add(current.text);
          visit(declaration.initializer);
        }
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return references;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function containsZodBuilder(node: ts.Node): boolean {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(current)) {
      let expression: ts.Expression = current.expression;
      while (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression)) {
        expression = expression.expression;
      }
      if (ts.isIdentifier(expression) && expression.text === 'z') {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function containsSchemaComponentMaterial(unit: SourceUnit, node: ts.Node, visited: Set<string>): boolean {
  if (containsZodBuilder(node) || referencedSchemas(unit, node).size > 0) return true;
  const localConstants = localConstDeclarations(unit);
  let found = false;
  function visit(current: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(current)) {
      if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) return;
      if (ts.isPropertyAssignment(current.parent) && current.parent.name === current) return;
      const declaration = localConstants.get(current.text);
      if (declaration?.initializer !== undefined && !visited.has(current.text)) {
        visited.add(current.text);
        if (containsSchemaComponentMaterial(unit, declaration.initializer, visited)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isSchemaComponent(unit: SourceUnit, declaration: ts.VariableDeclaration): boolean {
  if (declaration.initializer === undefined || !ts.isIdentifier(declaration.name)) return false;
  const initializer = unwrapExpression(declaration.initializer);
  if (
    declaration.name.text.endsWith('Schema') &&
    !ts.isObjectLiteralExpression(initializer) &&
    !ts.isArrayLiteralExpression(initializer)
  ) {
    return false;
  }
  return containsSchemaComponentMaterial(unit, initializer, new Set([declaration.name.text]));
}

function referencedSchemaComponents(unit: SourceUnit, node: ts.Node): ReadonlySet<SchemaKey> {
  const localConstants = localConstDeclarations(unit);
  const references = new Set<SchemaKey>();
  const visitedConstants = new Set<string>();
  function visit(current: ts.Node): void {
    if (ts.isIdentifier(current)) {
      if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) return;
      if (ts.isPropertyAssignment(current.parent) && current.parent.name === current) return;
      const declaration = localConstants.get(current.text);
      if (declaration?.initializer !== undefined && !visitedConstants.has(current.text)) {
        visitedConstants.add(current.text);
        if (isSchemaComponent(unit, declaration)) references.add(schemaKey(unit.path, current.text));
        visit(declaration.initializer);
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return references;
}

function isPersistenceCall(node: ts.CallExpression): boolean {
  if (
    node.arguments.some(
      (argument) => ts.isStringLiteralLike(argument) && /\b(?:DELETE|INSERT|SELECT|UPDATE)\b/iu.test(argument.text),
    )
  ) {
    return true;
  }
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'zodPersistedContract' || callee.text === 'zodPersistedParser';
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return /^(?:appendFile|readFile|writeAtomic|writeFile)/u.test(callee.name.text);
}

function containsPersistenceCall(node: ts.Node): boolean {
  let found = false;
  function visit(current: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(current) && isPersistenceCall(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function durableBoundaryBodies(unit: SourceUnit): readonly ts.Node[] {
  const bodies: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) &&
      node.body !== undefined &&
      containsPersistenceCall(node.body)
    ) {
      bodies.push(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(unit.source);
  return bodies;
}

function discoveredBoundarySchemas(unit: SourceUnit): ReadonlySet<SchemaKey> {
  const schemas = new Set<SchemaKey>();
  const functions = localFunctions(unit);
  const pending = [...durableBoundaryBodies(unit)];
  const visitedFunctions = new Set<string>();
  while (pending.length > 0) {
    const body = pending.pop();
    if (body === undefined) continue;
    for (const schema of referencedSchemas(unit, body)) schemas.add(schema);
    function visit(current: ts.Node): void {
      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
        const name = current.expression.text;
        const called = functions.get(name);
        if (called !== undefined && !visitedFunctions.has(name)) {
          visitedFunctions.add(name);
          pending.push(called);
        }
      }
      ts.forEachChild(current, visit);
    }
    visit(body);
  }
  return schemas;
}

function localSchemaDependencies(
  unit: SourceUnit,
  key: SchemaKey,
  declaration: ts.VariableDeclaration,
): readonly SchemaKey[] {
  const path = key.slice(0, key.lastIndexOf('#'));
  return [...referencedSchemas(unit, declaration.initializer ?? declaration)].filter((dependency) =>
    dependency.startsWith(`${path}#`),
  );
}

function durableSchemaClosure(
  units: readonly SourceUnit[],
  declarations: ReadonlyMap<SchemaKey, ts.VariableDeclaration>,
  roots: ReadonlySet<SchemaKey>,
): ReadonlySet<SchemaKey> {
  const unitsByPath = new Map(units.map((unit) => [unit.path, unit]));
  const durable = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined) continue;
    const declaration = declarations.get(key);
    if (declaration === undefined) continue;
    const path = key.slice(0, key.lastIndexOf('#'));
    const unit = unitsByPath.get(path);
    if (unit === undefined) continue;
    for (const dependency of localSchemaDependencies(unit, key, declaration)) {
      if (!declarations.has(dependency) || durable.has(dependency)) continue;
      durable.add(dependency);
      pending.push(dependency);
    }
  }
  return durable;
}

function factorySchemaRoots(units: readonly SourceUnit[]): ReadonlySet<SchemaKey> {
  const roots = new Set<SchemaKey>();
  for (const unit of units) {
    const functions = localFunctions(unit);
    for (const factory of DURABLE_SCHEMA_FACTORIES) {
      const separator = factory.lastIndexOf('#');
      if (factory.slice(0, separator) !== unit.path) continue;
      const fn = functions.get(factory.slice(separator + 1));
      if (fn === undefined) continue;
      for (const dependency of referencedSchemas(unit, fn)) {
        if (dependency.startsWith(`${unit.path}#`)) roots.add(dependency);
      }
    }
  }
  return roots;
}

function registrySchemaRoots(units: readonly SourceUnit[]): ReadonlySet<SchemaKey> {
  const roots = new Set<SchemaKey>();
  for (const unit of units) {
    for (const registry of DURABLE_SCHEMA_REGISTRIES) {
      const separator = registry.lastIndexOf('#');
      if (registry.slice(0, separator) !== unit.path) continue;
      const declaration = findVariable(unit, registry.slice(separator + 1));
      if (declaration === null) continue;
      for (const dependency of referencedSchemas(unit, declaration.initializer ?? declaration)) roots.add(dependency);
    }
  }
  return roots;
}

function unclassifiedSchemaViolations(
  declarations: ReadonlyMap<SchemaKey, ts.VariableDeclaration>,
  classifiedSchemas: ReadonlySet<SchemaKey>,
): string[] {
  return [...declarations.keys()]
    .filter((key) => !classifiedSchemas.has(key))
    .sort()
    .map((key) => `${key}: schema has no durable or in-memory classification`);
}

function unregisteredBoundaryViolations(
  units: readonly SourceUnit[],
  durableSchemas: ReadonlySet<SchemaKey>,
): string[] {
  return units.flatMap((unit) =>
    [...discoveredBoundarySchemas(unit)]
      .filter((key) => !durableSchemas.has(key) && !IN_MEMORY_PERSISTENCE_CONTEXT_SCHEMAS.has(key))
      .sort()
      .map((key) => `${key}: persistence boundary schema is not registered as durable`),
  );
}

function borrowedSchemaViolations(
  units: readonly SourceUnit[],
  declarations: ReadonlyMap<SchemaKey, ts.VariableDeclaration>,
  durableSchemas: ReadonlySet<SchemaKey>,
): string[] {
  const unitsByPath = new Map(units.map((unit) => [unit.path, unit]));
  const violations: string[] = [];
  for (const key of durableSchemas) {
    const declaration = declarations.get(key);
    if (declaration === undefined) continue;
    const path = key.slice(0, key.lastIndexOf('#'));
    const unit = unitsByPath.get(path);
    if (unit === undefined) continue;
    const borrowed = new Set<SchemaKey>();
    for (const target of referencedSchemas(unit, declaration.initializer ?? declaration)) {
      if (target === key) continue;
      if (!durableSchemas.has(target)) borrowed.add(target);
    }
    for (const target of borrowed) violations.push(`${key}: embeds or derives from non-durable schema ${target}`);
  }
  return violations;
}

function borrowedFactoryViolations(units: readonly SourceUnit[], durableSchemas: ReadonlySet<SchemaKey>): string[] {
  const violations: string[] = [];
  for (const unit of units) {
    const functions = localFunctions(unit);
    for (const factory of DURABLE_SCHEMA_FACTORIES) {
      const separator = factory.lastIndexOf('#');
      if (factory.slice(0, separator) !== unit.path) continue;
      const fn = functions.get(factory.slice(separator + 1));
      if (fn === undefined) continue;
      for (const target of referencedSchemas(unit, fn)) {
        if (!durableSchemas.has(target)) {
          violations.push(`${factory}: embeds or derives from non-durable schema ${target}`);
        }
      }
    }
  }
  return violations;
}

function durableSchemaComponents(
  units: readonly SourceUnit[],
  declarations: ReadonlyMap<SchemaKey, ts.VariableDeclaration>,
  durableSchemas: ReadonlySet<SchemaKey>,
): ReadonlySet<SchemaKey> {
  const unitsByPath = new Map(units.map((unit) => [unit.path, unit]));
  const components = new Set<SchemaKey>();
  for (const key of durableSchemas) {
    const declaration = declarations.get(key);
    if (declaration === undefined) continue;
    const path = key.slice(0, key.lastIndexOf('#'));
    const unit = unitsByPath.get(path);
    if (unit === undefined) continue;
    for (const component of referencedSchemaComponents(unit, declaration.initializer ?? declaration)) {
      components.add(component);
    }
  }
  for (const unit of units) {
    const functions = localFunctions(unit);
    for (const factory of DURABLE_SCHEMA_FACTORIES) {
      const separator = factory.lastIndexOf('#');
      if (factory.slice(0, separator) !== unit.path) continue;
      const fn = functions.get(factory.slice(separator + 1));
      if (fn === undefined) continue;
      for (const component of referencedSchemaComponents(unit, fn)) components.add(component);
    }
  }
  return components;
}

function componentRegistrationViolations(components: ReadonlySet<SchemaKey>): string[] {
  return [...components]
    .filter((key) => !DURABLE_SCHEMA_COMPONENTS.has(key))
    .sort()
    .map((key) => `${key}: durable schema component is not registered`);
}

describe('durable schema independence invariant', () => {
  // One parse of every production source is the floor here: measured 2.0s alone and 5.4s under the full
  // unit suite (10-core Apple M-series, 2026-09-17). CI run 35189468102 (ubuntu-latest 4 vCPU, Node 26)
  // measured this case at 9.1s against 7.1s under the same suite locally on the code it ran; the sibling
  // whole-tree invariants measured 2.0x on that run, and two runners on one tree measured a third apart,
  // so the budget is at least twice the CI cost a 2.0x ratio predicts for 5.4s rather than the suite
  // default.
  it('keeps durable shapes independent from in-memory schema objects', () => {
    const units = readSourceTree('src');
    const declarations = schemaDeclarations(units);
    const roots = new Set([...DURABLE_SCHEMA_ROOTS, ...factorySchemaRoots(units), ...registrySchemaRoots(units)]);
    const durableSchemas = durableSchemaClosure(units, declarations, roots);
    const components = durableSchemaComponents(units, declarations, durableSchemas);
    expect(componentRegistrationViolations(components)).toEqual([]);
    expect(unregisteredBoundaryViolations(units, durableSchemas)).toEqual([]);
    expect(borrowedSchemaViolations(units, declarations, durableSchemas)).toEqual([]);
    expect(borrowedFactoryViolations(units, durableSchemas)).toEqual([]);
  }, 20_000);

  it('rejects an unclassified schema at an ordinary database persistence boundary', () => {
    const fixture = readFixture('unregistered-database-row');
    const declarations = schemaDeclarations([fixture]);
    expect(unclassifiedSchemaViolations(declarations, new Set())).toEqual([
      `${fixture.path}#forgottenRowSchema: schema has no durable or in-memory classification`,
    ]);
    expect(unregisteredBoundaryViolations([fixture], new Set())).toEqual([
      `${fixture.path}#forgottenRowSchema: persistence boundary schema is not registered as durable`,
    ]);
  });

  it.each([
    'borrowed-shape',
    'borrowed-validator',
    'borrowed-modifier-chain',
    'borrowed-namespace',
    'borrowed-local-spread',
  ])('rejects durable schema borrowing in-memory schema objects in %s', (fixtureName) => {
    const fixture = readFixture(fixtureName);
    const inMemory = readFixture('in-memory-schema');
    const units = [fixture, inMemory];
    const declarations = schemaDeclarations(units);
    const durableRoot = schemaKey(fixture.path, 'durableRecordSchema');
    const durableSchemas = durableSchemaClosure(units, declarations, new Set([durableRoot]));
    expect(borrowedSchemaViolations(units, declarations, durableSchemas)).toEqual([
      `${durableRoot}: embeds or derives from non-durable schema ${FIXTURE_ROOT}/in-memory-schema.ts#inMemorySchema`,
    ]);
  });

  it('rejects an unregistered object shape shared with an in-memory schema', () => {
    const fixture = readFixture('borrowed-local-component');
    const declarations = schemaDeclarations([fixture]);
    const durableRoot = schemaKey(fixture.path, 'durableRecordSchema');
    const durableSchemas = durableSchemaClosure([fixture], declarations, new Set([durableRoot]));
    const components = durableSchemaComponents([fixture], declarations, durableSchemas);
    expect(componentRegistrationViolations(components)).toEqual([
      `${fixture.path}#sharedRecordShape: durable schema component is not registered`,
    ]);
  });
});
