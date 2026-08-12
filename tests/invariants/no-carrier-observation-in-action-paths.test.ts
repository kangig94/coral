import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from '#tests/helpers/ts-import-scanner.js';
import {
  serviceabilityDecisionClosureInventory,
  type DecisionSymbol,
} from './provider-serviceability-decision-inventory.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(join(REPO_ROOT, 'src'));
const IMPORT_EDGES: ParsedImportEdge[] = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILE_PATHS);
const CANONICAL_FILES = new Set(PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath)));
const PRODUCTION_FILES_BY_CANONICAL_PATH = new Map(
  PRODUCTION_FILE_PATHS.map((filePath) => [toCanonicalSrcPath(REPO_ROOT, filePath), filePath] as const),
);
const SOURCE_FILES_BY_CANONICAL_PATH = new Map(
  [...PRODUCTION_FILES_BY_CANONICAL_PATH].map(([path, filePath]) => [
    path,
    ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  ]),
);
const SERVICEABILITY_CLASSIFIER_PATH = /^src\/providers\/[^/]+\/serviceability\.ts$/u;
const SERVICEABILITY_COMPOSITION = 'src/providers/bootstrap.ts';
const SERVICEABILITY_SEAM = 'src/providers/serviceability.ts';
const HOST_ADMISSION = 'src/providers/host-admission.ts';
const COORDINATOR_ADMISSION_LEAF = 'src/coordinator/live/provider-host-admission.ts';
const PROXY_ADMISSION_LEAF = 'src/provider-proxy/provider-host-admission.ts';
const COORDINATOR_OWNER = 'src/coordinator/live/provider-hosts/index.ts';
const COORDINATOR_COMPOSITION = 'src/coordinator/index.ts';
const COORDINATOR_WORLD = 'src/coordinator/composition/world.ts';
const PROXY_OWNER = 'src/provider-proxy/provider-root-authority.ts';

/**
 * Carrier observation's authority, and who may hold it.
 *
 * The classifier is pure and local, so asking it costs nothing and health/idle may ask it freely — what they
 * may not do is let the answer authorize a mutation. There is deliberately no network-observer authority
 * alongside it: the bounded network observer that once paired with this classifier
 * (`src/coordinator/live/carrier-observer.ts`) was deleted for having no importer anywhere in `src/` — both
 * of its intended callers never wired it in. A coordinator that probed the network to decide whether hard
 * retirement is safe would have made a remote process the authority over local durable state, which is why,
 * if a network observer returns, it belongs on this list from the moment it gains its first importer.
 */
type ObservationAuthority = {
  readonly module: string;
  readonly what: string;
  /** Modules and directory roots permitted to import it. Everything else is a violation. */
  readonly permittedImporters: readonly string[];
};

const OBSERVATION_AUTHORITIES: readonly ObservationAuthority[] = [
  {
    module: 'src/jobs/carrier-observation.ts',
    what: 'the pure carrier classifier',
    permittedImporters: [
      // Health snapshots are assembled in composition, which is why that root — not a `health.ts` or
      // `coordinator/live/idle.ts` — is what appears here: composition is what may ask the classifier so
      // health/idle never need a network observer to do it.
      'src/coordinator/composition/',
    ],
    // Not listed: `src/jobs/shell/`. The wait stream reports observation beside stored phase, but it reaches
    // the classifier only through composition — its own edge is `import type { CarrierLiveness }`, which is
    // erased before anything runs and so needs no permission. Listing it granted a runtime capability nothing
    // used, which would have silently pre-authorized a later value import of the classifier itself.
  },
  {
    module: 'src/coordinator/live/carrier-observer.ts',
    what: 'the bounded network carrier observer',
    permittedImporters: ['src/coordinator/composition/'],
  },
  {
    module: 'src/providers/serviceability.ts',
    what: 'the derived provider-host serviceability classifier',
    permittedImporters: [COORDINATOR_ADMISSION_LEAF, PROXY_ADMISSION_LEAF],
  },
];

/**
 * Where a carrier verdict must never reach, because everything here decides the fate of durable state.
 *
 * Derived absence is a reading, not a fact: it can be produced by a slow socket or a foreign build, and the
 * whole point of the tri-state is that only the journal ends a job. A recovery walk that filtered its
 * candidates by observation would skip exactly the stored-nonterminal work it exists to settle, and a
 * cleanup pass that deleted on it would delete artifacts belonging to a job still running.
 */
const ACTION_PATH_ROOTS = [
  'src/recovery/',
  'src/coordinator/services/recovery/',
  'src/coordinator/startup-recovery.ts',
  'src/coordinator/shutdown-recovery.ts',
  'src/coordinator/services/terminal-materializer.ts',
  'src/jobs/reconcile/',
] as const;

/** Every production module under an action-path root — the entry points the walk starts from. */
const ACTION_PATH_MODULES: readonly string[] = [...CANONICAL_FILES]
  .filter((file) => ACTION_PATH_ROOTS.some((root) => (root.endsWith('/') ? file.startsWith(root) : file === root)))
  .sort();

type DecisionAuthority = DecisionSymbol &
  Readonly<{
    category: string;
    permittedImporters: readonly string[];
  }>;

function permittedDecisionImporters(category: string, decision: DecisionSymbol): readonly string[] {
  if (category === 'classifierDispatchers') {
    return decision.path === SERVICEABILITY_COMPOSITION
      ? [SERVICEABILITY_SEAM]
      : [COORDINATOR_ADMISSION_LEAF, PROXY_ADMISSION_LEAF];
  }
  if (category === 'providerClassifiers') {
    const match = SERVICEABILITY_CLASSIFIER_PATH.exec(decision.path);
    if (match === null) throw new Error(`Unexpected provider classifier path ${decision.path}`);
    return [decision.path.replace(/serviceability\.ts$/u, 'definition.ts')];
  }
  if (category === 'serviceabilityReducers') return [HOST_ADMISSION];
  if (category === 'admissionSymbols') {
    return decision.symbol === 'createHostAdmissionCollection'
      ? [COORDINATOR_ADMISSION_LEAF, PROXY_ADMISSION_LEAF, COORDINATOR_OWNER, COORDINATOR_WORLD]
      : [];
  }
  if (category === 'admissionCompositionLeaves') {
    return decision.path === COORDINATOR_ADMISSION_LEAF ? [COORDINATOR_COMPOSITION] : [PROXY_OWNER];
  }
  throw new Error(`Unmapped serviceability decision category ${category}`);
}

const SERVICEABILITY_DECISION_INVENTORY = serviceabilityDecisionClosureInventory(REPO_ROOT, PRODUCTION_FILE_PATHS);
const SERVICEABILITY_DECISION_AUTHORITIES: readonly DecisionAuthority[] = Object.entries(
  SERVICEABILITY_DECISION_INVENTORY,
).flatMap(([category, decisions]) =>
  category === 'factPublishers'
    ? []
    : decisions.map((decision) => ({
        ...decision,
        category,
        permittedImporters: permittedDecisionImporters(category, decision),
      })),
);

/**
 * Runtime consumers allowed to participate in the serviceability decision. The two owner modules are
 * intentionally absent: they receive only the admission collection created by their constrained leaf, never
 * the classifier itself. Keeping this inventory explicit makes a moved or newly added decision module fail
 * visibly instead of silently falling outside the walk.
 */
const SERVICEABILITY_RUNTIME_CONSUMERS = [
  'src/providers/bootstrap.ts',
  'src/providers/serviceability.ts',
  'src/providers/host-serviceability.ts',
  'src/providers/host-admission.ts',
  ...[...CANONICAL_FILES].filter((file) => SERVICEABILITY_CLASSIFIER_PATH.test(file)),
  COORDINATOR_ADMISSION_LEAF,
  PROXY_ADMISSION_LEAF,
] as const;

/** Named capabilities a serviceability decision must never reach over runtime imports. */
const DESTRUCTIVE_CAPABILITY_ROOTS = [
  'src/coordinator/live/provider-hosts/drain.ts',
  'src/provider-proxy/provider-root-authority.ts',
  'src/coordinator/live/provider-hosts/recovery.ts',
  'src/recovery/',
  'src/coordinator/services/recovery/',
  'src/coordinator/startup-recovery.ts',
  'src/coordinator/shutdown-recovery.ts',
  'src/jobs/reconcile/',
  'src/coordinator/services/provider-operation-reconciler.ts',
  'src/coordinator/services/terminal-materializer.ts',
] as const;

const DESTRUCTIVE_CAPABILITY_MODULES: readonly string[] = [...CANONICAL_FILES]
  .filter((file) =>
    DESTRUCTIVE_CAPABILITY_ROOTS.some((root) => (root.endsWith('/') ? file.startsWith(root) : file === root)),
  )
  .sort();

type ConstrainedAdmissionLeaf = {
  readonly module: string;
  readonly permittedDependencies: readonly string[];
};

const CONSTRAINED_ADMISSION_LEAVES: readonly ConstrainedAdmissionLeaf[] = [
  {
    module: COORDINATOR_ADMISSION_LEAF,
    permittedDependencies: ['src/providers/host-admission.ts', 'src/providers/serviceability.ts'],
  },
  {
    module: PROXY_ADMISSION_LEAF,
    permittedDependencies: ['src/providers/host-admission.ts', 'src/providers/serviceability.ts'],
  },
];

function matches(module: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => (entry.endsWith('/') ? module.startsWith(entry) : module === entry));
}

/**
 * Runtime edges into `authority.module` from a source `permittedImporters` does not name. Filtered to
 * `edge.runtime` for the same reason the reachability walk above is: a `import type` is erased before
 * anything runs, so it can hand no verdict to anyone, and this function is the one place both the real check
 * and its own mutation test call, so they cannot drift apart on that filter.
 */
function permittedImportViolations(edges: readonly ParsedImportEdge[], authority: ObservationAuthority): string[] {
  return edges
    .filter(
      (edge) => edge.runtime && edge.target === authority.module && !matches(edge.source, authority.permittedImporters),
    )
    .map((edge) => `${edge.source} imports ${edge.specifier} (${edge.via}) from ${authority.module}`);
}

type ImportedRuntimeSymbol = Readonly<{
  source: string;
  target: string;
  specifier: string;
  via: ParsedImportEdge['via'];
  localSymbol: string;
  symbol: string;
}>;

function importEdgeKey(source: string, specifier: string, via: ParsedImportEdge['via']): string {
  return `${source}\0${specifier}\0${via}`;
}

function runtimeImportedSymbols(): ImportedRuntimeSymbol[] {
  const edgesBySyntax = new Map(
    IMPORT_EDGES.filter((edge) => edge.runtime).map((edge) => [
      importEdgeKey(edge.source, edge.specifier, edge.via),
      edge,
    ]),
  );
  const imports: ImportedRuntimeSymbol[] = [];

  function record(
    source: string,
    specifier: string,
    via: ParsedImportEdge['via'],
    symbols: ReadonlyArray<Readonly<{ localSymbol: string; symbol: string }>>,
  ): void {
    const edge = edgesBySyntax.get(importEdgeKey(source, specifier, via));
    if (edge === undefined) return;
    for (const symbol of symbols) imports.push({ ...edge, ...symbol });
  }

  for (const [source, sourceFile] of SOURCE_FILES_BY_CANONICAL_PATH) {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const symbols: Array<{ localSymbol: string; symbol: string }> = [];
        const clause = node.importClause;
        if (clause !== undefined && !clause.isTypeOnly) {
          if (clause.name !== undefined) symbols.push({ localSymbol: clause.name.text, symbol: 'default' });
          if (clause.namedBindings !== undefined) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              symbols.push({ localSymbol: clause.namedBindings.name.text, symbol: '*' });
            } else {
              symbols.push(
                ...clause.namedBindings.elements.flatMap((element) =>
                  element.isTypeOnly
                    ? []
                    : [
                        {
                          localSymbol: element.name.text,
                          symbol: element.propertyName?.text ?? element.name.text,
                        },
                      ],
                ),
              );
            }
          }
        }
        record(source, node.moduleSpecifier.text, 'ImportDeclaration', symbols);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        let symbols: ReadonlyArray<Readonly<{ localSymbol: string; symbol: string }>>;
        if (node.isTypeOnly) {
          symbols = [];
        } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
          symbols = node.exportClause.elements.flatMap((element) =>
            element.isTypeOnly
              ? []
              : [
                  {
                    localSymbol: element.name.text,
                    symbol: element.propertyName?.text ?? element.name.text,
                  },
                ],
          );
        } else {
          symbols = [{ localSymbol: '*', symbol: '*' }];
        }
        record(source, node.moduleSpecifier.text, 'ExportDeclaration', symbols);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        record(source, node.arguments[0].text, 'DynamicImport', [{ localSymbol: '*', symbol: '*' }]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return imports;
}

const IMPORTED_RUNTIME_SYMBOLS = runtimeImportedSymbols();
const SERVICEABILITY_DECISION_IMPORTS: readonly ImportedRuntimeSymbol[] = IMPORTED_RUNTIME_SYMBOLS.flatMap((imported) =>
  SERVICEABILITY_DECISION_AUTHORITIES.flatMap((authority) =>
    imported.target === authority.path && (imported.symbol === '*' || imported.symbol === authority.symbol)
      ? [{ ...imported, symbol: authority.symbol }]
      : [],
  ),
);

function decisionImportViolations(imports: readonly ImportedRuntimeSymbol[], authority: DecisionAuthority): string[] {
  return imports
    .filter(
      (entry) =>
        entry.target === authority.path &&
        entry.symbol === authority.symbol &&
        !matches(entry.source, authority.permittedImporters),
    )
    .map(
      (entry) => `${entry.source} imports ${entry.symbol} from ${entry.target} via ${entry.specifier} (${entry.via})`,
    );
}

/**
 * Runtime edges only. A `import type` is erased before anything runs, so it can hand no verdict to anyone —
 * and following it would report the module graph rather than the capability. Without this the walk reports
 * `recovery/index.ts -> handoff.ts -> lifecycle.ts -> …`, a chain whose middle two hops are type-only.
 */
function runtimeAdjacency(edges: readonly ParsedImportEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.runtime) continue;
    const existing = adjacency.get(edge.source);
    if (existing === undefined) adjacency.set(edge.source, [edge.target]);
    else existing.push(edge.target);
  }
  return adjacency;
}

const ADJACENCY = runtimeAdjacency(IMPORT_EDGES);

/**
 * Every module reachable from `entry` over runtime imports, with the shortest path that reached each one.
 *
 * Reachability, not direct edges. The property is "an action path must not obtain a carrier verdict", and a
 * direct-edge rule protects that only if no permitted module can hand the verdict on — which any ordinary
 * wrapper function does, without re-exporting anything, so banning re-export closes one hop and leaves the
 * rest.
 */
function reachableFrom(
  entry: string,
  adjacency: ReadonlyMap<string, readonly string[]> = ADJACENCY,
): Map<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const path = paths.get(current) as readonly string[];
    for (const next of adjacency.get(current) ?? []) {
      if (paths.has(next)) continue;
      paths.set(next, [...path, next]);
      queue.push(next);
    }
  }
  return paths;
}

function symbolKey(path: string, symbol: string): string {
  return `${path}#${symbol}`;
}

function topLevelValueDeclarations(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Node> {
  const declarations = new Map<string, ts.Node>();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      declarations.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
    }
  }
  return declarations;
}

function referencedIdentifiers(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function decisionTaintPaths(imports: readonly ImportedRuntimeSymbol[]): ReadonlyMap<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>(
    SERVICEABILITY_DECISION_AUTHORITIES.map((authority) => {
      const key = symbolKey(authority.path, authority.symbol);
      return [key, [key]] as const;
    }),
  );
  const declarations = new Map(
    [...SOURCE_FILES_BY_CANONICAL_PATH].map(([path, sourceFile]) => [path, topLevelValueDeclarations(sourceFile)]),
  );

  let changed = true;
  while (changed) {
    changed = false;

    for (const imported of imports) {
      const targetPath =
        imported.symbol === '*'
          ? [...paths]
              .filter(([key]) => key.startsWith(`${imported.target}#`))
              .sort(([left], [right]) => left.localeCompare(right))[0]?.[1]
          : paths.get(symbolKey(imported.target, imported.symbol));
      const localKey = symbolKey(imported.source, imported.localSymbol);
      if (targetPath !== undefined && !paths.has(localKey)) {
        paths.set(localKey, [localKey, ...targetPath]);
        changed = true;
      }
    }

    for (const [path, moduleDeclarations] of declarations) {
      for (const [name, declaration] of moduleDeclarations) {
        const declarationKey = symbolKey(path, name);
        if (paths.has(declarationKey)) continue;
        const dependencyPath = [...referencedIdentifiers(declaration)]
          .map((identifier) => paths.get(symbolKey(path, identifier)))
          .find((candidate) => candidate !== undefined);
        if (dependencyPath !== undefined) {
          paths.set(declarationKey, [declarationKey, ...dependencyPath]);
          changed = true;
        }
      }
    }

    for (const [path, sourceFile] of SOURCE_FILES_BY_CANONICAL_PATH) {
      for (const statement of sourceFile.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          statement.moduleSpecifier !== undefined ||
          statement.isTypeOnly ||
          statement.exportClause === undefined ||
          !ts.isNamedExports(statement.exportClause)
        ) {
          continue;
        }
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const localName = element.propertyName?.text ?? element.name.text;
          const localPath = paths.get(symbolKey(path, localName));
          const exportedKey = symbolKey(path, element.name.text);
          if (localPath !== undefined && !paths.has(exportedKey)) {
            paths.set(exportedKey, [exportedKey, ...localPath]);
            changed = true;
          }
        }
      }
    }
  }

  return paths;
}

function serviceabilityDecisionActionPathViolations(
  imports: readonly ImportedRuntimeSymbol[],
  actionModules: readonly string[] = ACTION_PATH_MODULES,
): string[] {
  const actionModuleSet = new Set(actionModules);
  const taintPaths = decisionTaintPaths(imports);
  const violations = imports.flatMap((imported) => {
    if (!actionModuleSet.has(imported.source)) return [];
    const path =
      imported.symbol === '*'
        ? [...taintPaths]
            .filter(([key]) => key.startsWith(`${imported.target}#`))
            .sort(([left], [right]) => left.localeCompare(right))[0]?.[1]
        : taintPaths.get(symbolKey(imported.target, imported.symbol));
    return path === undefined ? [] : [[imported.source, ...path].join(' -> ')];
  });
  return [...new Set(violations)].sort();
}

/** Roots naming nothing. A directory root matches by prefix, a file root by identity. */
function unmatchedRoots(roots: readonly string[]): string[] {
  return roots.filter((root) =>
    root.endsWith('/') ? ![...CANONICAL_FILES].some((file) => file.startsWith(root)) : !CANONICAL_FILES.has(root),
  );
}

function constrainedLeafImportViolations(edges: readonly ParsedImportEdge[], leaf: ConstrainedAdmissionLeaf): string[] {
  return edges
    .filter((edge) => edge.source === leaf.module && !leaf.permittedDependencies.includes(edge.target))
    .map((edge) => `${leaf.module} -> ${edge.target} (${edge.via} ${edge.specifier})`);
}

describe('carrier observation never reaches mutation or recovery paths', () => {
  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.module, authority] as const))(
    '%s exists, so this invariant cannot pass by naming nothing',
    (module, authority) => {
      // A declared authority that does not exist would make every check below vacuously true — the exact
      // failure mode an invariant is supposed to rule out rather than exhibit.
      expect(CANONICAL_FILES).toContain(module);
      expect(authority.permittedImporters.length).toBeGreaterThan(0);
      // A permitted importer naming nothing is the opposite failure: it silently widens the ban instead of
      // narrowing it, and it hides that the module it was written for has moved or gone.
      expect(unmatchedRoots(authority.permittedImporters)).toEqual([]);
    },
  );

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.module, authority] as const))(
    '%s is actually imported, so this invariant is not vacuously green over an empty set',
    (module, authority) => {
      // `edge.runtime` for the same reason the ban itself filters on it: an `import type` is erased before
      // anything runs, so it neither needs a permission nor proves one is exercised. Counting it here would
      // let this check answer "exercised" about an edge the enforcement check does not even look at.
      const importers = IMPORT_EDGES.filter((edge) => edge.runtime && edge.target === module).map(
        (edge) => edge.source,
      );
      // An authority nobody imports is not being guarded by any check in this file — reachability,
      // permission, and re-export all pass trivially over an empty edge set. That is exactly how a module
      // with no importer anywhere in `src/` (the deleted `coordinator/live/carrier-observer.ts`) stayed
      // declared here with every check green: the checks below all ran, and all passed, over nothing.
      expect(importers.length).toBeGreaterThan(0);

      // The same failure at finer grain: a permitted-importer entry nothing imports through is a permission
      // nobody exercises, and an unexercised permission is indistinguishable from one that no longer applies.
      const unexercised = authority.permittedImporters.filter(
        (entry) => !importers.some((source) => matches(source, [entry])),
      );
      expect(unexercised).toEqual([]);
    },
  );

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.what, authority] as const))(
    '%s is reachable from no action path, at any import depth',
    (_what, authority) => {
      const violations = ACTION_PATH_MODULES.flatMap((entry) => {
        const path = reachableFrom(entry).get(authority.module);
        // The whole path, not just the endpoint: a transitive violation is only actionable if you can see
        // which hop introduced it.
        return path === undefined ? [] : [path.join(' -> ')];
      });

      expect(violations).toEqual([]);
    },
  );

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.what, authority] as const))(
    '%s is imported only where it is permitted',
    (_what, authority) => {
      expect(permittedImportViolations(IMPORT_EDGES, authority)).toEqual([]);
    },
  );

  it('derives every non-fact decision authority from the complete shared serviceability inventory', () => {
    const decisionEntries = Object.entries(SERVICEABILITY_DECISION_INVENTORY).filter(
      ([category]) => category !== 'factPublishers',
    );
    expect(decisionEntries.length).toBeGreaterThan(0);
    expect(decisionEntries.filter(([, decisions]) => decisions.length === 0)).toEqual([]);
    expect(SERVICEABILITY_DECISION_AUTHORITIES).toHaveLength(
      decisionEntries.reduce((count, [, decisions]) => count + decisions.length, 0),
    );
    expect(unmatchedRoots(SERVICEABILITY_DECISION_AUTHORITIES.map((authority) => authority.path))).toEqual([]);
    expect(
      unmatchedRoots(SERVICEABILITY_DECISION_AUTHORITIES.flatMap((authority) => authority.permittedImporters)),
    ).toEqual([]);
  });

  it('permits every serviceability decision symbol only at its declared runtime importers', () => {
    const violations = SERVICEABILITY_DECISION_AUTHORITIES.flatMap((authority) =>
      decisionImportViolations(SERVICEABILITY_DECISION_IMPORTS, authority),
    );
    expect(violations).toEqual([]);

    const unexercisedPermissions = SERVICEABILITY_DECISION_AUTHORITIES.flatMap((authority) =>
      authority.permittedImporters.flatMap((permittedImporter) =>
        SERVICEABILITY_DECISION_IMPORTS.some(
          (entry) =>
            entry.target === authority.path &&
            entry.symbol === authority.symbol &&
            matches(entry.source, [permittedImporter]),
        )
          ? []
          : [`${authority.path}#${authority.symbol} <- ${permittedImporter}`],
      ),
    );
    expect(unexercisedPermissions).toEqual([]);
  });

  it('keeps every inventoried serviceability decision symbol unreachable from every action path', () => {
    expect(serviceabilityDecisionActionPathViolations(IMPORTED_RUNTIME_SYMBOLS)).toEqual([]);
  });

  it.each([
    {
      name: 'recovery imports the bootstrap dispatcher',
      source: 'src/coordinator/services/recovery/service.ts',
      target: SERVICEABILITY_COMPOSITION,
      symbol: 'classifyProviderResponseServiceability',
      specifier: '../../../providers/bootstrap.js',
    },
    {
      name: 'reconciliation imports the bootstrap dispatcher',
      source: 'src/jobs/reconcile/registry.ts',
      target: SERVICEABILITY_COMPOSITION,
      symbol: 'classifyProviderResponseServiceability',
      specifier: '../../providers/bootstrap.js',
    },
    {
      name: 'recovery imports a concrete provider classifier',
      source: 'src/coordinator/services/recovery/service.ts',
      target: 'src/providers/codex/serviceability.ts',
      symbol: 'classifyCodexProviderResponseServiceability',
      specifier: '../../../providers/codex/serviceability.js',
    },
    {
      name: 'reconciliation imports a concrete provider classifier',
      source: 'src/jobs/reconcile/registry.ts',
      target: 'src/providers/codex/serviceability.ts',
      symbol: 'classifyCodexProviderResponseServiceability',
      specifier: '../../providers/codex/serviceability.js',
    },
  ])('rejects $name and names its own action path', ({ source, target, symbol, specifier }) => {
    const authority = SERVICEABILITY_DECISION_AUTHORITIES.find(
      (candidate) => candidate.path === target && candidate.symbol === symbol,
    );
    expect(authority).toBeDefined();
    if (authority === undefined) throw new Error(`Missing decision authority ${target}#${symbol}`);

    const edge: ParsedImportEdge = {
      source,
      target,
      specifier,
      via: 'ImportDeclaration',
      runtime: true,
      typeOnly: false,
    };
    const imported: ImportedRuntimeSymbol = {
      source,
      target,
      specifier,
      via: edge.via,
      localSymbol: symbol,
      symbol,
    };

    expect(decisionImportViolations([imported], authority)).toEqual([
      `${source} imports ${symbol} from ${target} via ${specifier} (ImportDeclaration)`,
    ]);
    expect(serviceabilityDecisionActionPathViolations([...IMPORTED_RUNTIME_SYMBOLS, imported], [source])).toContain(
      `${source} -> ${target}#${symbol}`,
    );
  });

  it('still bans a runtime edge from an unpermitted importer, even though a type-only edge from the same place passes', () => {
    const authority = OBSERVATION_AUTHORITIES[0];
    const unpermittedSource = 'src/coordinator/services/operation-registry.ts';
    const runtimeEdge: ParsedImportEdge = {
      source: unpermittedSource,
      target: authority.module,
      specifier: '../../jobs/carrier-observation.js',
      via: 'ImportDeclaration',
      runtime: true,
      typeOnly: false,
    };
    const typeOnlyEdge: ParsedImportEdge = { ...runtimeEdge, runtime: false, typeOnly: true };

    expect(permittedImportViolations([runtimeEdge], authority)).toEqual([
      `${unpermittedSource} imports ${runtimeEdge.specifier} (ImportDeclaration) from ${authority.module}`,
    ]);
    expect(permittedImportViolations([typeOnlyEdge], authority)).toEqual([]);
  });

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.what, authority] as const))(
    '%s is never re-exported, so no module can launder it past the import rules above',
    (_what, authority) => {
      // Independent of the reachability walk above, and kept because it protects a different thing: a
      // re-export makes the importing module a second canonical home for the symbol, which
      // design-philosophy forbids outright regardless of who ends up reaching it.
      const reexports = IMPORT_EDGES.filter(
        (edge) => edge.target === authority.module && edge.via === 'ExportDeclaration',
      ).map((edge) => `${edge.source} re-exports ${edge.specifier} from ${authority.module}`);

      expect(reexports).toEqual([]);
    },
  );

  it('names action paths that all exist', () => {
    // A root that matches nothing silently narrows the ban — the module it was written for was renamed or
    // deleted, and the rule quietly stopped covering anything.
    expect(unmatchedRoots(ACTION_PATH_ROOTS)).toEqual([]);
  });

  it('names a non-empty runtime serviceability consumer set whose every module exists', () => {
    expect(SERVICEABILITY_RUNTIME_CONSUMERS.length).toBeGreaterThan(0);
    expect(unmatchedRoots(SERVICEABILITY_RUNTIME_CONSUMERS)).toEqual([]);
  });

  it('names a non-empty destructive capability set whose every root exists', () => {
    expect(DESTRUCTIVE_CAPABILITY_MODULES.length).toBeGreaterThan(0);
    expect(unmatchedRoots(DESTRUCTIVE_CAPABILITY_ROOTS)).toEqual([]);
  });

  it('keeps every runtime serviceability consumer outbound-unreachable from destructive capabilities', () => {
    const destructiveCapabilities = new Set(DESTRUCTIVE_CAPABILITY_MODULES);
    const violations = SERVICEABILITY_RUNTIME_CONSUMERS.flatMap((consumer) =>
      [...reachableFrom(consumer).entries()].flatMap(([module, path]) =>
        destructiveCapabilities.has(module) ? [path.join(' -> ')] : [],
      ),
    );

    expect([...new Set(violations)].sort()).toEqual([]);
  });

  it.each(CONSTRAINED_ADMISSION_LEAVES.map((leaf) => [leaf.module, leaf] as const))(
    '%s imports only the classifier and narrow admission port modules',
    (module, leaf) => {
      expect(CANONICAL_FILES).toContain(module);
      expect(leaf.permittedDependencies.length).toBeGreaterThan(0);
      expect(unmatchedRoots(leaf.permittedDependencies)).toEqual([]);
      expect(constrainedLeafImportViolations(IMPORT_EDGES, leaf)).toEqual([]);
    },
  );
});
