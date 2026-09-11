import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_ROOT = resolve(REPO_ROOT, 'tests/invariants/fixtures/process-observation-composition');
const PROCESS_PORT_PATH = 'src/runtime/ports.ts';
const PROCESS_OWNER_PATTERN = /^src\/infra\/process-[^/]+\.ts$/u;

type RegistrySpec = Readonly<{
  key: string;
  undecided: readonly (string | number)[];
}>;

const REGISTRY = [
  { key: 'src/infra/node-process.ts#ProcessLiveness', undecided: ['unknown'] },
  { key: 'src/infra/port-types.ts#ExecOutcome', undecided: ['no-answer'] },
  { key: 'src/infra/process-containment.ts#RecordedContainmentObservation', undecided: ['unobservable'] },
  { key: 'src/infra/process-containment.ts#RecordedContainmentReapResult', undecided: ['identity-unobservable'] },
  { key: 'src/infra/process-supervision.ts#GracefulKillDisposition', undecided: [] },
  { key: 'src/infra/process-supervision.ts#GracefulKillOutcome', undecided: ['target-unobservable'] },
  { key: 'src/infra/process-supervision.ts#GracefulKillByPidDisposition', undecided: [] },
  { key: 'src/infra/process-supervision.ts#GracefulKillByPidOutcome', undecided: ['target-unobservable'] },
  { key: 'src/infra/process-supervision.ts#SpawnedProcessGroupCleanupDisposition', undecided: ['held-unobservable'] },
  {
    key: 'src/coordinator/services/provider-proxy-set/recorded-containment-reaper.ts#ProviderProxySetRecordedContainmentReapResult',
    undecided: ['identity-unobservable'],
  },
  {
    key: 'src/provider-proxy/control-client.ts#ControlExchange',
    undecided: ['no-response', 'delivery-unconfirmed', 'channel-fault'],
  },
  { key: 'src/provider-proxy/role-spawn.ts#RoleSpawnCleanupDisposition', undecided: ['held-unobservable'] },
  {
    key: 'src/providers/app-server-transport.ts#ProviderServerFailedSpawnCleanupDisposition',
    undecided: ['held-unobservable'],
  },
  {
    key: 'src/coordinator/services/provider-proxy-set/operator-disposition-store.ts#DurableProviderProxySetOperatorDispositionWriteResult',
    undecided: ['unconfirmed'],
  },
] as const satisfies readonly RegistrySpec[];

const STRUCTURAL_SUBTYPE_REGISTRY = new Set<string>(['src/provider-proxy/control-client.ts#ControlExchange']);

const SOURCE_VOCABULARY_EXEMPTIONS = new Map<string, string>([
  ['src/runtime/ports.ts#ProcessPort.spawn', 'spawn failure is still reported later by the child error event'],
  ['src/runtime/ports.ts#ProcessPort.exec', 'legacy raw exec result is classified by ExecOutcome at its consumers'],
  [
    'src/runtime/ports.ts#ProcessPort.execSync',
    'legacy raw synchronous exec result is classified by ExecOutcome at its consumers',
  ],
  ['src/runtime/ports.ts#ProcessPort.kill', 'process-control refusal is still collapsed into a boolean'],
  [
    'src/runtime/ports.ts#ProcessPort.readProcessIncarnation',
    'an unavailable or failed incarnation observation is still collapsed into null',
  ],
]);

type CompositionDebt = Readonly<{ reason: string; exit: string }>;

function debt(reason: string, exit: string): CompositionDebt {
  return { reason, exit };
}

const COMPOSITION_DEBTS = new Map<string, CompositionDebt>([
  [
    'src/coordinator/composition/execution-services.ts#createExecutionServices.initializeProviderProxyLifecycle',
    debt(
      'lifecycle initialization installs a ProcessLiveness observer through a void composition boundary',
      'initializeProviderProxyLifecycle returns the lifecycle initialization disposition',
    ),
  ],
  [
    'src/coordinator/live/durable-transport.ts#spawnDurableJobTransport.enterContainmentHold.setInterval',
    debt(
      'periodic containment retry reports through retained cleanup state while the timer callback returns void',
      'enterContainmentHold exposes the retained cleanup disposition from its timer boundary',
    ),
  ],
  [
    'src/coordinator/live/durable-transport.ts#spawnDurableJobTransport.publishSpawned',
    debt(
      'durable identity publication restarts cleanup without exposing its disposition',
      'publishSpawned returns the restarted cleanup disposition',
    ),
  ],
  [
    'src/coordinator/live/durable-transport.ts#spawnDurableJobTransport.publishWrapperSpawned',
    debt(
      'provisional publication starts abort cleanup without exposing its disposition',
      'publishWrapperSpawned returns the abort-cleanup disposition',
    ),
  ],
  [
    'src/coordinator/live/durable-transport.ts#spawnDurableJobTransport.retry',
    debt(
      'operator retry triggers retained containment cleanup through a void control method',
      'spawnDurableJobTransport.retry returns the retained cleanup disposition',
    ),
  ],
  [
    'src/coordinator/live/admission.ts#LaunchCoordinator.terminateAll.startAttempt.then:0',
    debt(
      'the fulfillment callback stores the completed cleanup disposition in LaunchCoordinator cleanup-attempt ownership',
      'LaunchCoordinator.terminateAll consumes the stored cleanup disposition',
    ),
  ],
  [
    'src/coordinator/live/admission.ts#LaunchCoordinator.terminateAll.startAttempt.then:1',
    debt(
      'the rejection callback stores the completed cleanup failure in LaunchCoordinator cleanup-attempt ownership',
      'LaunchCoordinator.terminateAll consumes the stored cleanup failure',
    ),
  ],
  [
    'src/coordinator/live/kb-daemon-supervisor.ts#createKbDaemonSupervisor.acceptKbDaemonKill',
    debt(
      'daemon lifecycle callbacks retain and observe graceful-kill settlement while their public lifecycle result remains the daemon snapshot',
      'acceptKbDaemonKill consumes immediate failure and its settlement callback consumes scheduled outcomes',
    ),
  ],
  [
    'src/coordinator/live/kb-daemon-supervisor.ts#createKbDaemonSupervisor.acceptKbDaemonKill.then',
    debt(
      'the settlement callback consumes non-absence into the retained daemon supervisor failure state',
      'the daemon close observer or a later stopNow retry resolves the retained daemon obligation',
    ),
  ],
  [
    'src/coordinator/live/kb-daemon-supervisor.ts#requestKbDaemonKill.then',
    debt(
      'the settlement callback releases the completed attempt from kbDaemonKills single-flight ownership',
      'acceptKbDaemonKill consumes the settlement outcome',
    ),
  ],
  [
    'src/coordinator/live/provider-hosts/drain.ts#containmentReaperWithClock.anonymous',
    debt(
      'provider-host reaping reports unresolved containment through rejection instead of returning the reap disposition',
      'containmentReaperWithClock returns ProviderProxySetRecordedContainmentReapResult',
    ),
  ],
  [
    'src/coordinator/live/provider-proxy/spawn-undo.ts#buildGuardianSpawnUndo.perform',
    debt(
      'guardian spawn undo converts control and reap holds to rejected completion',
      'buildGuardianSpawnUndo.perform returns its unresolved control or reap disposition',
    ),
  ],
  [
    'src/coordinator/live/provider-proxy/spawn-undo.ts#requireAcknowledgedAbsence',
    debt(
      'guardian teardown acknowledgement converts every non-acknowledged control disposition to an exception',
      'requireAcknowledgedAbsence returns the non-acknowledged ControlExchange',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-operation-activation.ts#routeControlExchangeFailure',
    debt(
      'legacy failure routing consumes ControlExchange through reporting callbacks while its caller throws',
      'routeControlExchangeFailure returns the unresolved ControlExchange',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-operation-activation.ts#callStrict',
    debt(
      'strict operation control converts every non-result ControlExchange into reporting plus rejection',
      'callStrict returns the unresolved ControlExchange to its operation boundary',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.installDiscoveredCapsule',
    debt(
      'capsule installation consumes ProcessLiveness and records its decision only in lifecycle state',
      'ProviderProxySetLifecycle.installDiscoveredCapsule returns the recorded lifecycle disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#recordedProcessesAllAbsent',
    debt(
      'the all-absent predicate collapses alive and unknown into the same false result',
      'recordedProcessesAllAbsent returns a three-answer aggregate observation',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#recordedProcessesAllAbsent.every',
    debt(
      'the array predicate collapses alive and unknown while requiring every recorded process to be absent',
      'recordedProcessesAllAbsent performs the aggregate classification outside the array predicate',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.recoverExactCapsule.evidence',
    debt(
      'the dispatcher starts recorded-containment reaping and settles exact-capsule recovery through lifecycle state',
      'recoverExactCapsule.evidence returns the reap disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.recoverExactCapsule.evidence.then:0',
    debt(
      'exact-capsule recovery commits absence or schedules another attempt through a void continuation',
      'recoverExactCapsule.evidence.then returns the lifecycle disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.runControlReattachmentAttempt.evidence',
    debt(
      'the dispatcher starts recorded-containment reaping and settles control reattachment through lifecycle state',
      'runControlReattachmentAttempt.evidence returns the reap disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.runControlReattachmentAttempt.evidence.then:0',
    debt(
      'control reattachment commits absence or schedules another attempt through a void continuation',
      'runControlReattachmentAttempt.evidence.then returns the lifecycle disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.runReattachmentHoldAttempt.evidence',
    debt(
      'the dispatcher starts recorded-containment reaping and settles the reattachment hold through lifecycle state',
      'runReattachmentHoldAttempt.evidence returns the reap disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.runReattachmentHoldAttempt.evidence.then:0',
    debt(
      'reattachment hold commits absence or retains retry ownership through a void continuation',
      'runReattachmentHoldAttempt.evidence.then returns the retained lifecycle disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.runContainmentAttempt.evidence',
    debt(
      'the dispatcher starts recorded-containment reaping and settles containment through lifecycle state',
      'runContainmentAttempt.evidence returns the reap disposition',
    ),
  ],
  [
    'src/coordinator/services/provider-proxy-set/index.ts#ProviderProxySetLifecycle.runContainmentAttempt.evidence.then:0',
    debt(
      'containment attempt forwards the reap disposition into lifecycle completion without returning it',
      'runContainmentAttempt.evidence.then returns the lifecycle completion disposition',
    ),
  ],
  [
    'src/coordinator/services/recovery/interrupted-performer.ts#reapProviderOperationCarrier',
    debt(
      'carrier recovery reports every non-absence reap disposition by throwing from Promise<void>',
      'reapProviderOperationCarrier returns ProviderProxySetRecordedContainmentReapResult',
    ),
  ],
  [
    'src/coordinator/services/recovery/snapshot.ts#buildRecoverySnapshot.isPidAlive',
    debt(
      'recovery planning maps unknown liveness to alive so only proven absence authorizes stale-runtime recovery',
      'buildRecoverySnapshot.isPidAlive returns the three-answer process observation',
    ),
  ],
  [
    'src/infra/process-supervision.ts#settleGracefulKill.finish',
    debt(
      'the settlement sink resolves Promise<GracefulKillOutcome> through a void function',
      'settleGracefulKill.finish returns the graceful-kill outcome to its promise boundary',
    ),
  ],
  [
    'src/infra/process-supervision.ts#settleGracefulKillByPid.setTimeout',
    debt(
      'the timer continuation routes its process disposition into the owning promise through a void callback',
      'settleGracefulKillByPid.setTimeout resolves the owning Promise<GracefulKillByPidOutcome>',
    ),
  ],
  [
    'src/kb-daemon/daemon-main.ts#startKbDaemonParentWatchdog.setIntervalFn',
    debt(
      'the watchdog callback finalizes only absence while alive and unknown retain ownership until the next tick',
      'startKbDaemonParentWatchdog.setIntervalFn returns the watchdog observation disposition',
    ),
  ],
  [
    'src/kb/curate/frontmatter-merge-driver.ts#mergeBodiesWithGit',
    debt(
      'merge-file no-answer is raised because the current return type admits only numeric merge results',
      'mergeBodiesWithGit returns ExecOutcome beside the merge result',
    ),
  ],
  [
    'src/kb/ops/source/import.ts#runCommand',
    debt(
      'legacy command execution translates ExecOutcome into completion or throw instead of returning its disposition',
      'runCommand returns ExecOutcome to the import boundary',
    ),
  ],
  [
    'src/provider-proxy/control-client.ts#connectControlClient.createFrameReader',
    debt(
      'the frame callback preserves ControlExchange by resolving its request promise through a void parser callback',
      'connectControlClient.createFrameReader returns the frame-routing disposition',
    ),
  ],
  [
    'src/provider-proxy/control-client.ts#connectControlClient.on:1',
    debt(
      'the socket-close callback preserves ControlExchange by settling pending request promises through a void listener',
      'connectControlClient.on returns the close-routing disposition',
    ),
  ],
  [
    'src/provider-proxy/control-client.ts#connectControlClient.faultInvalidFrame',
    debt(
      'invalid-frame handling preserves ControlExchange by settling pending requests before closing the socket',
      'connectControlClient.faultInvalidFrame returns the channel-fault disposition',
    ),
  ],
  [
    'src/provider-proxy/control-client.ts#connectControlClient.settleAll',
    debt(
      'the fan-out sink preserves its ControlExchange by resolving every pending request promise',
      'connectControlClient.settleAll returns the fan-out settlement disposition',
    ),
  ],
  [
    'src/provider-proxy/control-client.ts#connectControlClient.exchange.Promise',
    debt(
      'the Promise executor owns Promise<ControlExchange> and resolves synchronous write refusal through void control flow',
      'connectControlClient.exchange.Promise resolves Promise<ControlExchange>',
    ),
  ],
  [
    'src/provider-proxy/control-client.ts#connectControlClient.exchange.setTimeout',
    debt(
      'the timeout callback preserves no-response by resolving the owning Promise<ControlExchange>',
      'connectControlClient.exchange.setTimeout resolves Promise<ControlExchange>',
    ),
  ],
  [
    'src/provider-proxy/guardian.ts#createGuardian.abortReaperContainmentPrepare',
    debt(
      'best-effort reaper abort consumes ControlExchange while retry ownership remains with later prepare attempts',
      'createGuardian.abortReaperContainmentPrepare returns the abort ControlExchange',
    ),
  ],
  [
    'src/provider-proxy/guardian.ts#createGuardian.recordContainment',
    debt(
      'guardian containment recording converts ControlExchange failure into rejection after local ownership is armed',
      'createGuardian.recordContainment returns the recording ControlExchange',
    ),
  ],
  [
    'src/provider-proxy/role-main.ts#createProxyGuardianContainment.stageProviderRoot.abortAndRelease',
    debt(
      'guardian release converts ControlExchange failure into rejection while guardian-side ownership remains idempotent',
      'stageProviderRoot.abortAndRelease returns the release ControlExchange',
    ),
  ],
  [
    'src/provider-proxy/role-spawn.ts#spawnRoleProcess.holdFailedSpawn.retry.then',
    debt(
      'the settlement callback stores the graceful-kill outcome in retained role-spawn cleanup state',
      'the cleanup retry consumes killOutcome or childSettled observes closure',
    ),
  ],
  [
    'src/providers/app-server-transport.ts#acceptProviderServerKill',
    debt(
      'provider-server event callbacks retain and observe graceful-kill settlement while their event contracts return void',
      'ProviderProcessSettlement retains the outcome for terminateProviderServerProcess.retry or processClosePromise',
    ),
  ],
  [
    'src/providers/app-server-transport.ts#acceptProviderServerKill.then',
    debt(
      'the settlement callback stores the graceful-kill outcome in ProviderProcessSettlement ownership',
      'terminateProviderServerProcess.retry consumes terminationOutcome or processClosePromise observes closure',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#createContainedGroupSettlement.retain',
    debt(
      'retained group cleanup consumes graceful-kill settlement through group-finalizer state while its control method returns void',
      'handoff transfers cleanup or finish observes group absence',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#createContainedGroupSettlement.retain.then',
    debt(
      'the settlement callback retains non-absence in active group state and re-drives the finalizer handoff',
      'handoff transfers cleanup or the group observation settles through finish',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#createContainedGroupSettlement.handoff.once',
    debt(
      'the finalizer-ready listener consumes graceful-kill settlement through retained group state while the event contract returns void',
      'retain continues cleanup or finish observes group absence',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#createContainedGroupSettlement.handoff.then',
    debt(
      'the settlement callback retains non-absence in active group state and enters retained cleanup',
      'retain continues termination and observation until handoff or finish',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#groupMembers.retry.then',
    debt(
      'the settlement callback records observer absence through the retained group-member observation promise',
      'settle resolves the observation or its hold transfers through handoff',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#requestObservedChildKill.then',
    debt(
      'the settlement callback releases the completed attempt from observedChildKills single-flight ownership',
      'groupMembers.retry, retained group cleanup, or runWrapper.terminateChild consumes the settlement outcome',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#runWrapper.terminateChild',
    debt(
      'the signal callback consumes graceful-kill settlement through retained group state while the signal contract returns void',
      'retryTermination re-drives termination or group settlement observes completion',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#runWrapper.terminateChild.then',
    debt(
      'the settlement callback retains non-absence in wrapper group-settlement ownership',
      'retryTermination re-drives termination or group settlement observes completion',
    ),
  ],
  [
    'src/runtime/durable-cli-wrapper.ts#runGroupFinalizer.setInterval',
    debt(
      'the polling callback retains alive and unknown ownership implicitly and returns no timer disposition',
      'runGroupFinalizer.setInterval returns the group observation disposition',
    ),
  ],
  [
    'src/runtime/real.ts#createRealRuntime.terminateProcessIncarnationProbe',
    debt(
      'probe cleanup retains settlement in the process-incarnation probe registry while its terminator port returns void',
      'ProcessIncarnationProbeTerminator returns the graceful-kill disposition',
    ),
  ],
  [
    'src/infra/process-containment.ts#observeContainment',
    debt(
      'unknown group liveness is translated into ProcessContainmentError',
      'observeContainment returns an unobservable TargetObservation',
    ),
  ],
]);

type RegistryEntry = Readonly<{
  key: string;
  type: ts.Type;
  union: readonly ts.Type[];
  undecided: ReadonlySet<string | number>;
}>;

type AnalysisContext = Readonly<{
  root: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  sources: readonly ts.SourceFile[];
  registry: readonly RegistryEntry[];
}>;

type Violation = Readonly<{ boundary: string; reason: string }>;

type BodyFunction = ts.FunctionLikeDeclaration & Readonly<{ body: ts.ConciseBody }>;

function canonicalPath(root: string, fileName: string): string {
  return relative(root, fileName).replaceAll('\\', '/');
}

function readTsConfig(root: string): ts.CompilerOptions {
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  return { ...parsed.options, composite: false, incremental: false, noEmit: true, tsBuildInfoFile: undefined };
}

function productionProgram(overlays: ReadonlyMap<string, string> = new Map()): ts.Program {
  const srcRoot = resolve(REPO_ROOT, 'src');
  const rootNames: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) rootNames.push(path);
    }
  };
  visit(srcRoot);
  const options = readTsConfig(REPO_ROOT);
  const overlayFiles = new Map([...overlays].map(([path, source]) => [resolve(REPO_ROOT, path), source]));
  const defaultHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => overlayFiles.has(fileName) || defaultHost.fileExists(fileName),
    readFile: (fileName) => overlayFiles.get(fileName) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const overlay = overlayFiles.get(fileName);
      return overlay === undefined
        ? defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, overlay, languageVersion, true, ts.ScriptKind.TS);
    },
  };
  return ts.createProgram({ rootNames: [...rootNames, ...overlayFiles.keys()], options, host });
}

function fixtureProgram(source: string): ts.Program {
  const path = resolve(FIXTURE_ROOT, 'subject.ts');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => fileName === path || defaultHost.fileExists(fileName),
    readFile: (fileName) => (fileName === path ? source : defaultHost.readFile(fileName)),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === path
        ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
        : defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile),
    writeFile: () => {
      throw new Error('Process observation fixture Programs are read-only.');
    },
  };
  return ts.createProgram({ rootNames: [path], options, host });
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol === undefined) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
}

function exportedType(context: Omit<AnalysisContext, 'registry'>, key: string): ts.Type {
  const separator = key.lastIndexOf('#');
  const path = resolve(context.root, key.slice(0, separator));
  const exportName = key.slice(separator + 1);
  const source = context.program.getSourceFile(path);
  if (source === undefined) throw new Error(`${key}: registry module is absent from the TypeScript Program`);
  const moduleSymbol = context.checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${key}: registry module has no symbol`);
  const symbol = context.checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === exportName);
  if (symbol === undefined) throw new Error(`${key}: registry export is absent`);
  const declaration = canonicalSymbol(context.checker, symbol)?.declarations?.[0];
  if (declaration === undefined) throw new Error(`${key}: registry export has no declaration`);
  return context.checker.getTypeAtLocation(declaration);
}

function semanticUnion(type: ts.Type): readonly ts.Type[] {
  if (type.isUnion()) return type.types;
  if (type.isIntersection()) {
    const union = type.types.find((member) => member.isUnion());
    if (union?.isUnion()) return union.types;
  }
  return [];
}

function createContext(program: ts.Program, root: string, registrySpecs: readonly RegistrySpec[]): AnalysisContext {
  const diagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  }
  const checker = program.getTypeChecker();
  const sources = program
    .getSourceFiles()
    .filter((source) => !source.isDeclarationFile && source.fileName.startsWith(`${resolve(root)}/`));
  const base = { root, program, checker, sources };
  const registry = registrySpecs.map(({ key, undecided }) => {
    const type = exportedType(base, key);
    const union = semanticUnion(type);
    const discriminator = unionDiscriminator(checker, type);
    if (discriminator === undefined) {
      throw new Error(`${key}: registry entry does not carry three distinctly discriminated answers`);
    }
    const missing = undecided.filter((answer) => !discriminator.values.includes(answer));
    if (missing.length > 0) {
      throw new Error(`${key}: undecided answers are not discriminants: ${missing.join(', ')}`);
    }
    return { key, type, union, undecided: new Set(undecided) };
  });
  return { ...base, registry };
}

function isUnusableType(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0;
}

function registeredEntry(context: AnalysisContext, type: ts.Type): RegistryEntry | undefined {
  if (isUnusableType(type)) return undefined;
  return context.registry.find((entry) => {
    if (type === entry.type) return true;
    const alias = canonicalSymbol(context.checker, type.aliasSymbol);
    const registeredAlias = canonicalSymbol(context.checker, entry.type.aliasSymbol);
    if (alias !== undefined && alias === registeredAlias) return true;
    if (STRUCTURAL_SUBTYPE_REGISTRY.has(entry.key) && context.checker.isTypeAssignableTo(type, entry.type)) {
      return true;
    }
    if ((type.flags & ts.TypeFlags.Object) !== 0 && entry.union.includes(type)) return true;
    const union = semanticUnion(type);
    if (union.length >= 2 && context.checker.isTypeAssignableTo(type, entry.type)) return true;
    return union.some((member) => (member.flags & ts.TypeFlags.Object) !== 0 && entry.union.includes(member));
  });
}

type UnionDiscriminator = Readonly<{
  property: string | null;
  values: readonly (string | number)[];
}>;

function literalValue(type: ts.Type): string | number | undefined {
  if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
  return undefined;
}

function unionDiscriminator(checker: ts.TypeChecker, type: ts.Type): UnionDiscriminator | undefined {
  const union = semanticUnion(type);
  if (union.length < 3) return undefined;
  const primitiveValues = union.map(literalValue);
  if (primitiveValues.every((value) => value !== undefined)) {
    const values = primitiveValues;
    return new Set(values).size === values.length ? { property: null, values } : undefined;
  }
  const commonProperties = union[0]?.getProperties().map((property) => property.name) ?? [];
  for (const name of commonProperties) {
    const values = union.map((member) => {
      const property = member.getProperty(name);
      const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
      if (property === undefined || declaration === undefined) return undefined;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      return literalValue(propertyType);
    });
    if (values.every((value) => value !== undefined) && new Set(values).size === union.length) {
      return { property: name, values };
    }
  }
  return undefined;
}

function unionHasNamedThirdAnswer(checker: ts.TypeChecker, type: ts.Type): boolean {
  return unionDiscriminator(checker, type) !== undefined;
}

function typeArguments(context: AnalysisContext, type: ts.Type): readonly ts.Type[] {
  return (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
    ? context.checker.getTypeArguments(type as ts.TypeReference)
    : [];
}

function typeCarriesVocabulary(context: AnalysisContext, type: ts.Type, seen = new Set<ts.Type>(), depth = 0): boolean {
  if (seen.has(type) || isUnusableType(type)) return false;
  seen.add(type);
  if (registeredEntry(context, type) !== undefined || unionHasNamedThirdAnswer(context.checker, type)) return true;
  if (
    type.isUnionOrIntersection() &&
    type.types.some((member) => typeCarriesVocabulary(context, member, seen, depth + 1))
  ) {
    return true;
  }
  if (typeArguments(context, type).some((argument) => typeCarriesVocabulary(context, argument, seen, depth + 1))) {
    return true;
  }
  if (
    type
      .getCallSignatures()
      .some((signature) => typeCarriesVocabulary(context, signature.getReturnType(), seen, depth + 1))
  ) {
    return true;
  }
  if (depth > 2) return false;
  return type.getProperties().some((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return (
      declaration !== undefined &&
      declaration.getSourceFile().fileName.startsWith(`${resolve(context.root)}/`) &&
      typeCarriesVocabulary(context, context.checker.getTypeOfSymbolAtLocation(property, declaration), seen, depth + 1)
    );
  });
}

function typeCarriesRegistry(context: AnalysisContext, type: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type) || isUnusableType(type)) return false;
  seen.add(type);
  if (registeredEntry(context, type) !== undefined) return true;
  if (typeArguments(context, type).some((argument) => typeCarriesRegistry(context, argument, seen))) return true;
  return type.getCallSignatures().some((signature) => typeCarriesRegistry(context, signature.getReturnType(), seen));
}

function declarationName(node: BodyFunction): string | undefined {
  if (node.name !== undefined && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))) {
    return node.name.text.replace(/^#/u, '');
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(node.parent)) {
    return node.parent.name.getText(node.getSourceFile());
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.parent.left)
  ) {
    return node.parent.left.text;
  }
  return undefined;
}

function namedScopeChain(node: ts.Node): string[] {
  const names: string[] = [];
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (isBodyFunction(current)) {
      const name = declarationName(current);
      if (name !== undefined) names.push(name);
    } else if (ts.isClassLike(current) && current.name !== undefined) {
      names.push(current.name.text);
    }
  }
  return names.reverse();
}

function calledScopeName(node: ts.CallExpression | ts.NewExpression): string {
  return ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : node.expression.getText(node.getSourceFile());
}

function boundaryScope(node: BodyFunction): string {
  const chain = namedScopeChain(node);
  if (declarationName(node) !== undefined) return chain.join('.');
  if (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) {
    return [...chain, calledScopeName(node.parent)].join('.');
  }
  if (ts.isConstructorDeclaration(node)) return [...chain, 'constructor'].join('.');
  return [...chain, 'anonymous'].join('.');
}

function boundaryName(context: AnalysisContext, node: BodyFunction): string {
  const path = canonicalPath(context.root, node.getSourceFile().fileName);
  const scope = boundaryScope(node);
  const collisions = functionLikeNodes(node.getSourceFile()).filter((candidate) => boundaryScope(candidate) === scope);
  const ordinal = collisions.length > 1 ? `:${collisions.indexOf(node)}` : '';
  return `${path}#${scope}${ordinal}`;
}

function isBodyFunction(node: ts.Node): node is BodyFunction {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)) &&
    node.body !== undefined
  );
}

function functionLikeNodes(source: ts.SourceFile): BodyFunction[] {
  const nodes: BodyFunction[] = [];
  const visit = (node: ts.Node): void => {
    if (isBodyFunction(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

function returnTypeOf(context: AnalysisContext, node: BodyFunction): ts.Type | undefined {
  return context.checker.getSignatureFromDeclaration(node)?.getReturnType();
}

function promisedType(context: AnalysisContext, type: ts.Type): ts.Type | undefined {
  const awaited = context.checker.getAwaitedType(type);
  return awaited === type ? undefined : awaited;
}

function forbiddenReturn(context: AnalysisContext, type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0) return true;
  const promised = promisedType(context, type);
  return promised !== undefined && forbiddenReturn(context, promised);
}

function refusedSourceReturn(context: AnalysisContext, type: ts.Type): boolean {
  const promised = promisedType(context, type);
  if (promised !== undefined) return refusedSourceReturn(context, promised);
  if ((type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0) return true;
  return type.isUnion() && type.types.some((member) => (member.flags & ts.TypeFlags.Null) !== 0);
}

function resolvedCallSignatures(type: ts.Type): readonly ts.Signature[] {
  const direct = type.getCallSignatures();
  if (direct.length > 0) return direct;
  if (!type.isUnionOrIntersection()) return [];
  return [...new Set(type.types.flatMap((member) => resolvedCallSignatures(member)))];
}

function typeNodeDeclaresCallable(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isFunctionTypeNode(type)) return true;
  if (ts.isTypeLiteralNode(type)) {
    return type.members.some((member) => ts.isCallSignatureDeclaration(member));
  }
  if (ts.isParenthesizedTypeNode(type)) return typeNodeDeclaresCallable(type.type);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(typeNodeDeclaresCallable);
  }
  return false;
}

function sourceVocabularyViolations(
  context: AnalysisContext,
  processPortPath = PROCESS_PORT_PATH,
  processOwnerPattern = PROCESS_OWNER_PATTERN,
): Violation[] {
  const violations: Violation[] = [];
  const port = context.program.getSourceFile(resolve(context.root, processPortPath));
  if (port === undefined) throw new Error(`${processPortPath}: ProcessPort source is absent`);
  const portDeclaration = port.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'ProcessPort',
  );
  if (portDeclaration === undefined) throw new Error(`${processPortPath}: ProcessPort interface is absent`);
  for (const member of portDeclaration.members) {
    const signatures = resolvedCallSignatures(context.checker.getTypeAtLocation(member));
    if (
      signatures.length === 0 &&
      (ts.isMethodSignature(member) ||
        ts.isCallSignatureDeclaration(member) ||
        (ts.isPropertySignature(member) && typeNodeDeclaresCallable(member.type)))
    ) {
      throw new Error(
        `${processPortPath}#ProcessPort.${member.name?.getText(port) ?? '<call>'}: callable member has no resolved signature`,
      );
    }
    for (const signature of signatures) {
      const type = signature.getReturnType();
      if (refusedSourceReturn(context, type) || !typeCarriesVocabulary(context, type)) {
        violations.push({
          boundary: `${processPortPath}#ProcessPort.${member.name?.getText(port) ?? '<call>'}`,
          reason: `returns ${context.checker.typeToString(type, member, ts.TypeFormatFlags.NoTruncation)}`,
        });
      }
    }
  }
  for (const source of context.sources) {
    const path = canonicalPath(context.root, source.fileName);
    if (!processOwnerPattern.test(path)) continue;
    const moduleSymbol = context.checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) throw new Error(`${path}: process-owner module has no symbol`);
    for (const exported of context.checker.getExportsOfModule(moduleSymbol)) {
      const symbol = canonicalSymbol(context.checker, exported);
      const declarations = symbol?.declarations;
      if (symbol === undefined || declarations === undefined || declarations.length === 0) {
        throw new Error(`${path}#${exported.name}: exported symbol has no declaration`);
      }
      const type = context.checker.getTypeOfSymbolAtLocation(symbol, declarations[0]);
      const signatures = resolvedCallSignatures(type);
      const declaredAsFunction = declarations.some(
        (declaration) =>
          ts.isFunctionDeclaration(declaration) ||
          (ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            isBodyFunction(declaration.initializer)) ||
          (ts.isExportAssignment(declaration) && isBodyFunction(declaration.expression)),
      );
      if (declaredAsFunction && signatures.length === 0) {
        throw new Error(`${path}#${exported.name}: exported function has no resolved signature`);
      }
      for (const signature of signatures) {
        const declaration = signature.getDeclaration() ?? declarations[0];
        const returnType = signature.getReturnType();
        if (typeCarriesRegistry(context, returnType) && refusedSourceReturn(context, returnType)) {
          violations.push({
            boundary: `${path}#${exported.name}`,
            reason: `returns ${context.checker.typeToString(returnType, declaration, ts.TypeFormatFlags.NoTruncation)}`,
          });
        }
      }
    }
  }
  return violations.sort((left, right) => left.boundary.localeCompare(right.boundary));
}

function functionRegistryCarriers(context: AnalysisContext, node: BodyFunction): string[] {
  const carriers = new Set<string>();
  for (const parameter of node.parameters) {
    const type = context.checker.getTypeAtLocation(parameter);
    for (const entry of context.registry) {
      const scoped = { ...context, registry: [entry] };
      if (typeCarriesRegistry(scoped, type)) carriers.add(`${entry.key} parameter ${parameter.name.getText()}`);
    }
  }
  const visit = (child: ts.Node): void => {
    if (child !== node && isBodyFunction(child)) return;
    if (ts.isCallExpression(child)) {
      const type = context.checker.getTypeAtLocation(child);
      const promised = promisedType(context, type);
      for (const entry of context.registry) {
        const scoped = { ...context, registry: [entry] };
        if (typeCarriesRegistry(scoped, type) || (promised !== undefined && typeCarriesRegistry(scoped, promised))) {
          carriers.add(`${entry.key} call ${child.expression.getText()}`);
        }
      }
    }
    ts.forEachChild(child, visit);
  };
  if (node.body !== undefined) visit(node.body);
  return [...carriers];
}

function discriminatedUndecidedBranchThrows(context: AnalysisContext, node: BodyFunction): boolean {
  let violation = false;
  const branchThrows = (branch: ts.Node): boolean => {
    let throws = false;
    const visit = (child: ts.Node): void => {
      if (throws || (child !== branch && isBodyFunction(child))) return;
      if (ts.isThrowStatement(child)) throws = true;
      else ts.forEachChild(child, visit);
    };
    visit(branch);
    return throws;
  };
  type DiscriminantSource = {
    entry: RegistryEntry;
    property: string | null;
  };
  const expressionLiteralValue = (expression: ts.Expression): string | number | undefined => {
    if (ts.isStringLiteral(expression)) return expression.text;
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    return undefined;
  };
  const bindingPropertyName = (binding: ts.BindingElement): string | undefined => {
    const property = binding.propertyName ?? binding.name;
    if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) {
      return property.text;
    }
    return undefined;
  };
  const discriminantSource = (expression: ts.Expression): DiscriminantSource | undefined => {
    if (ts.isParenthesizedExpression(expression)) return discriminantSource(expression.expression);
    if (ts.isPropertyAccessExpression(expression)) {
      const entry = registeredEntry(context, context.checker.getTypeAtLocation(expression.expression));
      const discriminator = entry === undefined ? undefined : unionDiscriminator(context.checker, entry.type);
      if (entry !== undefined && discriminator?.property === expression.name.text) {
        return { entry, property: expression.name.text };
      }
    }
    if (!ts.isIdentifier(expression)) return undefined;
    const directEntry = registeredEntry(context, context.checker.getTypeAtLocation(expression));
    const directDiscriminator =
      directEntry === undefined ? undefined : unionDiscriminator(context.checker, directEntry.type);
    if (directEntry !== undefined && directDiscriminator?.property === null) {
      return { entry: directEntry, property: null };
    }
    const symbol = canonicalSymbol(context.checker, context.checker.getSymbolAtLocation(expression));
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const owner = declaration.parent.parent;
        const source = ts.isVariableDeclaration(owner) ? owner.initializer : ts.isParameter(owner) ? owner : undefined;
        if (source === undefined) continue;
        const entry = registeredEntry(context, context.checker.getTypeAtLocation(source));
        const discriminator = entry === undefined ? undefined : unionDiscriminator(context.checker, entry.type);
        const property = bindingPropertyName(declaration);
        if (entry !== undefined && discriminator?.property === property) {
          return { entry, property: property ?? null };
        }
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
        const source = discriminantSource(declaration.initializer);
        if (source !== undefined) return source;
      }
    }
    return undefined;
  };
  const memberValue = (source: DiscriminantSource, value: string | number): string | number | undefined => {
    const discriminator = unionDiscriminator(context.checker, source.entry.type);
    if (discriminator === undefined || discriminator.property !== source.property) return undefined;
    return discriminator.values.includes(value) ? value : undefined;
  };
  const comparisonSelectionIncludesUndecided = (expression: ts.BinaryExpression, truthy: boolean): boolean => {
    const operator = expression.operatorToken.kind;
    if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      return false;
    }
    const leftLiteral = expressionLiteralValue(expression.left);
    const rightLiteral = expressionLiteralValue(expression.right);
    const literal = leftLiteral ?? rightLiteral;
    if (literal === undefined) return false;
    const value = leftLiteral === undefined ? expression.left : expression.right;
    const source = discriminantSource(value);
    if (source === undefined || memberValue(source, literal) === undefined) return false;
    const discriminator = unionDiscriminator(context.checker, source.entry.type);
    if (discriminator === undefined) return false;
    const equality = operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
    return discriminator.values.some(
      (candidate) => source.entry.undecided.has(candidate) && truthy === (equality === (candidate === literal)),
    );
  };
  const typeLiteralValues = (type: ts.Type): readonly (string | number)[] => {
    const members = semanticUnion(type);
    return (members.length === 0 ? [type] : members).flatMap((member) => {
      const value = literalValue(member);
      return value === undefined ? [] : [value];
    });
  };
  const guardedDiscriminatorValues = (entry: RegistryEntry, guardedType: ts.Type): readonly (string | number)[] => {
    const discriminator = unionDiscriminator(context.checker, entry.type);
    if (discriminator === undefined) return [];
    if (discriminator.property === null) return typeLiteralValues(guardedType);
    const property = context.checker.getPropertyOfType(guardedType, discriminator.property);
    const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
    if (property === undefined || declaration === undefined) return [];
    const propertyType = context.checker.getTypeOfSymbolAtLocation(property, declaration);
    return typeLiteralValues(propertyType);
  };
  const typeGuardSelectsUndecided = (expression: ts.CallExpression, truthy: boolean): boolean => {
    const signature = context.checker.getResolvedSignature(expression);
    const predicate = signature === undefined ? undefined : context.checker.getTypePredicateOfSignature(signature);
    if (predicate === undefined || predicate.type === undefined || predicate.kind !== ts.TypePredicateKind.Identifier) {
      return false;
    }
    const argument = expression.arguments[predicate.parameterIndex];
    if (argument === undefined) return false;
    const entry = registeredEntry(context, context.checker.getTypeAtLocation(argument));
    if (entry === undefined) return false;
    const guardedType = predicate.type;
    const discriminator = unionDiscriminator(context.checker, entry.type);
    const guardedValues = guardedDiscriminatorValues(entry, guardedType);
    const selected = new Set<string | number>();
    if (discriminator !== undefined && guardedValues.length > 0) {
      for (const value of discriminator.values) {
        if (guardedValues.includes(value)) selected.add(value);
      }
    } else {
      for (const [index, member] of entry.union.entries()) {
        const value = discriminator?.values[index];
        if (value !== undefined && context.checker.isTypeAssignableTo(member, guardedType)) selected.add(value);
      }
    }
    return [...entry.undecided].some((value) => truthy === selected.has(value));
  };
  const conditionSelectsUndecided = (expression: ts.Expression, truthy: boolean): boolean => {
    if (ts.isParenthesizedExpression(expression)) {
      return conditionSelectsUndecided(expression.expression, truthy);
    }
    if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
      return conditionSelectsUndecided(expression.operand, !truthy);
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      ) {
        return (
          conditionSelectsUndecided(expression.left, truthy) || conditionSelectsUndecided(expression.right, truthy)
        );
      }
      return comparisonSelectionIncludesUndecided(expression, truthy);
    }
    if (ts.isCallExpression(expression)) {
      return typeGuardSelectsUndecided(expression, truthy);
    }
    return false;
  };
  const switchHasViolation = (statement: ts.SwitchStatement): boolean => {
    const source = discriminantSource(statement.expression);
    if (source === undefined) return false;
    const handled = new Set<number>();
    for (const clause of statement.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        const literal = expressionLiteralValue(clause.expression);
        const value = literal === undefined ? undefined : memberValue(source, literal);
        const discriminator = unionDiscriminator(context.checker, source.entry.type);
        const index = value === undefined ? -1 : (discriminator?.values.indexOf(value) ?? -1);
        if (index >= 0) handled.add(index);
        if (value !== undefined && source.entry.undecided.has(value) && branchThrows(clause)) return true;
      } else if (ts.isDefaultClause(clause)) {
        const discriminator = unionDiscriminator(context.checker, source.entry.type);
        const remaining = discriminator?.values.filter((_, index) => !handled.has(index)) ?? [];
        if (remaining.some((value) => source.entry.undecided.has(value)) && branchThrows(clause)) return true;
      }
    }
    return false;
  };
  const visit = (child: ts.Node): void => {
    if (violation || (child !== node && isBodyFunction(child))) return;
    if (ts.isIfStatement(child)) {
      if (
        (conditionSelectsUndecided(child.expression, true) && branchThrows(child.thenStatement)) ||
        (child.elseStatement !== undefined &&
          conditionSelectsUndecided(child.expression, false) &&
          branchThrows(child.elseStatement))
      ) {
        violation = true;
        return;
      }
    }
    if (ts.isSwitchStatement(child) && switchHasViolation(child)) {
      violation = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  if (node.body !== undefined) visit(node.body);
  return violation;
}

function compositionViolations(context: AnalysisContext): Violation[] {
  const violations: Violation[] = [];
  for (const source of context.sources) {
    for (const node of functionLikeNodes(source)) {
      const carriers = functionRegistryCarriers(context, node);
      if (carriers.length === 0) continue;
      const boundary = boundaryName(context, node);
      const returnType = returnTypeOf(context, node);
      if (returnType !== undefined && forbiddenReturn(context, returnType)) {
        violations.push({ boundary, reason: `returns a refused completion primitive (${carriers.join(', ')})` });
      }
      if (discriminatedUndecidedBranchThrows(context, node)) {
        violations.push({
          boundary,
          reason: `throws after discriminating an undecided observation answer (${carriers.join(', ')})`,
        });
      }
    }
  }
  return violations.sort((left, right) =>
    left.boundary === right.boundary
      ? left.reason.localeCompare(right.reason)
      : left.boundary.localeCompare(right.boundary),
  );
}

function enforceAllowlist(violations: readonly Violation[], allowlist: ReadonlyMap<string, string>): string[] {
  const byBoundary = new Map<string, string[]>();
  for (const violation of violations) {
    const reasons = byBoundary.get(violation.boundary) ?? [];
    reasons.push(violation.reason);
    byBoundary.set(violation.boundary, reasons);
  }
  const failures = [...byBoundary]
    .filter(([boundary]) => !allowlist.has(boundary))
    .map(([boundary, reasons]) => `${boundary}: ${reasons.join('; ')}`);
  for (const [boundary, reason] of allowlist) {
    if (reason.trim() === '') failures.push(`${boundary}: allowlist reason is empty`);
    else if (!byBoundary.has(boundary)) failures.push(`${boundary}: stale allowlist entry (${reason})`);
  }
  return failures.sort();
}

function enforceDebts(violations: readonly Violation[], debts: ReadonlyMap<string, CompositionDebt>): string[] {
  const failures = enforceAllowlist(
    violations,
    new Map([...debts].map(([boundary, entry]) => [boundary, entry.reason])),
  );
  for (const [boundary, entry] of debts) {
    if (entry.exit.trim() === '') failures.push(`${boundary}: debt exit is empty`);
  }
  return failures.sort();
}

function fixtureContext(
  source: string,
  registrySpecs: readonly RegistrySpec[] = [{ key: 'subject.ts#Observation', undecided: ['unobservable'] }],
): AnalysisContext {
  const root = FIXTURE_ROOT;
  return createContext(fixtureProgram(source), root, registrySpecs);
}

function diagnosticsFor(program: ts.Program, path: string): string[] {
  const fileName = resolve(REPO_ROOT, path);
  const source = program.getSourceFile(fileName);
  if (source === undefined) throw new Error(`Missing process-observation fixture '${path}'.`);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map(
    (diagnostic) => `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  );
}

const PRODUCTION_CONTEXT = createContext(productionProgram(), REPO_ROOT, REGISTRY);

describe('process observation vocabulary composes without collapsing its third answer', () => {
  // This case resolves types across every `src/` file rather than reading text, so it is CPU-bound where the
  // suite's 15s default was calibrated for I/O-bound cases (see `vitest/default.ts`). Measured 3.8-4.1s on a
  // 24-core host and over 15s on a GitHub 2-core runner, which this suite deliberately oversubscribes to four
  // workers; the budget below carries that contention factor and still fails a hung walk promptly.
  it('keeps process-owned vocabulary and its composition explicit', () => {
    expect(enforceAllowlist(sourceVocabularyViolations(PRODUCTION_CONTEXT), SOURCE_VOCABULARY_EXEMPTIONS)).toEqual([]);
    expect(enforceDebts(compositionViolations(PRODUCTION_CONTEXT), COMPOSITION_DEBTS)).toEqual([]);
  }, 60_000);

  it('rejects primitive and null-bearing members added to ProcessPort', () => {
    const source = readFileSync(resolve(FIXTURE_ROOT, 'subject.ts.txt'), 'utf8');
    const primitiveMutation = source.replace(
      '  observe(): Observation;',
      '  observe(): Observation;\n  probeSomething(): boolean;',
    );
    expect(sourceVocabularyViolations(fixtureContext(primitiveMutation), 'subject.ts', /^never$/u)).toContainEqual({
      boundary: 'subject.ts#ProcessPort.probeSomething',
      reason: 'returns boolean',
    });

    const nullMutation = source.replace(
      '  observe(): Observation;',
      '  observe(): Observation;\n  observeMaybe(): Observation | null;\n  observeMaybeAsync(): Promise<Observation | null>;',
    );
    expect(sourceVocabularyViolations(fixtureContext(nullMutation), 'subject.ts', /^never$/u)).toEqual(
      expect.arrayContaining([
        { boundary: 'subject.ts#ProcessPort.observeMaybe', reason: 'returns Observation | null' },
        {
          boundary: 'subject.ts#ProcessPort.observeMaybeAsync',
          reason: 'returns Promise<Observation | null>',
        },
      ]),
    );

    const overloadedPropertyMutation = source.replace(
      '  observe(): Observation;',
      '  observe: { (): Observation; (legacy: true): boolean };',
    );
    expect(
      sourceVocabularyViolations(fixtureContext(overloadedPropertyMutation), 'subject.ts', /^never$/u),
    ).toContainEqual({
      boundary: 'subject.ts#ProcessPort.observe',
      reason: 'returns boolean',
    });

    const listedExportMutation = `${source}\nfunction listedProbe(): Observation | null { return null; }\nexport { listedProbe };\n`;
    expect(
      sourceVocabularyViolations(fixtureContext(listedExportMutation), 'subject.ts', /^subject\.ts$/u),
    ).toContainEqual({
      boundary: 'subject.ts#listedProbe',
      reason: 'returns Observation | null',
    });

    const defaultExportMutation = `${source}\nexport default ((observation: Observation): Observation | null => observation);\n`;
    expect(
      sourceVocabularyViolations(fixtureContext(defaultExportMutation), 'subject.ts', /^subject\.ts$/u),
    ).toContainEqual({
      boundary: 'subject.ts#default',
      reason: 'returns Observation | null',
    });
  });

  it('rejects primitive completion and throws after an undecided answer is discriminated', () => {
    const source = readFileSync(resolve(FIXTURE_ROOT, 'subject.ts.txt'), 'utf8');
    const primitiveMutation = source.replace(
      'export function translate(observation: Observation): Observation {\n  return observation;\n}',
      'export function translate(observation: Observation): void {\n  void observation;\n}',
    );
    expect(compositionViolations(fixtureContext(primitiveMutation)).map(({ boundary }) => boundary)).toContain(
      'subject.ts#translate',
    );

    const throwMutation = source.replace(
      '  return observation;',
      "  if (observation.kind !== 'present') throw new Error('not present');\n  return observation;",
    );
    expect(
      compositionViolations(fixtureContext(throwMutation)).some(
        ({ boundary, reason }) =>
          boundary === 'subject.ts#translate' && reason.startsWith('throws after discriminating'),
      ),
    ).toBe(true);

    const destructuredMutation = source.replace(
      '  return observation;',
      "  const { kind } = observation;\n  if (kind === 'unobservable') throw new Error('unobservable');\n  return observation;",
    );
    expect(
      compositionViolations(fixtureContext(destructuredMutation)).some(
        ({ boundary, reason }) =>
          boundary === 'subject.ts#translate' && reason.startsWith('throws after discriminating'),
      ),
    ).toBe(true);

    const destructuredParameterMutation = source.replace(
      'export function translate(observation: Observation): Observation {\n  return observation;\n}',
      "export function translate({ kind }: Observation): Observation {\n  if (kind === 'unobservable') throw new Error('unobservable');\n  throw new Error('fixture remainder');\n}",
    );
    expect(
      compositionViolations(fixtureContext(destructuredParameterMutation)).some(
        ({ boundary, reason }) =>
          boundary === 'subject.ts#translate' && reason.startsWith('throws after discriminating'),
      ),
    ).toBe(true);

    const guardedMutation = source
      .replace(
        'export function translate(observation: Observation): Observation {',
        "function isUnobservable(value: Observation): value is Extract<Observation, { kind: 'unobservable' }> {\n  return value.kind === 'unobservable';\n}\n\nexport function translate(observation: Observation): Observation {",
      )
      .replace(
        '  return observation;',
        "  if (isUnobservable(observation)) throw new Error('unobservable');\n  return observation;",
      );
    expect(
      compositionViolations(fixtureContext(guardedMutation)).some(
        ({ boundary, reason }) =>
          boundary === 'subject.ts#translate' && reason.startsWith('throws after discriminating'),
      ),
    ).toBe(true);

    const brandedSource = `${source}\ndeclare const observationBrand: unique symbol;\nexport type BrandedObservation = (\n  | { kind: 'present'; value: string }\n  | { kind: 'absent' }\n  | { kind: 'unobservable'; reason: string }\n) & { readonly [observationBrand]: true };\n\nfunction isBrandedUnobservable(\n  value: BrandedObservation,\n): value is BrandedObservation & { kind: 'unobservable' } {\n  return value.kind === 'unobservable';\n}\n\nexport function translateBranded(observation: BrandedObservation): BrandedObservation {\n  if (isBrandedUnobservable(observation)) throw new Error('unobservable');\n  return observation;\n}\n`;
    expect(
      compositionViolations(
        fixtureContext(brandedSource, [{ key: 'subject.ts#BrandedObservation', undecided: ['unobservable'] }]),
      ).some(
        ({ boundary, reason }) =>
          boundary === 'subject.ts#translateBranded' && reason.startsWith('throws after discriminating'),
      ),
    ).toBe(true);

    const numericMutation = source
      .replaceAll("'present'", '0')
      .replaceAll("'absent'", '1')
      .replaceAll("'unobservable'", '2')
      .replace(
        '  return observation;',
        "  if (observation.kind === 2) throw new Error('unobservable');\n  return observation;",
      );
    expect(
      compositionViolations(fixtureContext(numericMutation, [{ key: 'subject.ts#Observation', undecided: [2] }])).some(
        ({ boundary, reason }) =>
          boundary === 'subject.ts#translate' && reason.startsWith('throws after discriminating'),
      ),
    ).toBe(true);

    const decidedNonFirstMutation = source.replace(
      '  return observation;',
      "  if (observation.kind === 'absent') throw new Error('absent');\n  return observation;",
    );
    expect(compositionViolations(fixtureContext(decidedNonFirstMutation))).toEqual([]);

    const reordered = source.replace(
      "  | Readonly<{ kind: 'present' }>\n  | Readonly<{ kind: 'absent' }>\n  | Readonly<{ kind: 'unobservable'; reason: string }>",
      "  | Readonly<{ kind: 'unobservable'; reason: string }>\n  | Readonly<{ kind: 'present' }>\n  | Readonly<{ kind: 'absent' }>",
    );
    const reorderedThrow = reordered.replace(
      '  return observation;',
      "  if (observation.kind === 'unobservable') throw new Error('unobservable');\n  return observation;",
    );
    expect(compositionViolations(fixtureContext(reorderedThrow))).toEqual([
      expect.objectContaining({ boundary: 'subject.ts#translate' }),
    ]);
  });

  it('rejects a disposition write composed back into the old void-and-throw boundary', () => {
    const source = `${readFileSync(resolve(FIXTURE_ROOT, 'subject.ts.txt'), 'utf8')}\nexport type DispositionWrite =\n  | { kind: 'recorded'; disposition: 'recorded' }\n  | { kind: 'refused'; disposition: 'held'; reason: string }\n  | { kind: 'unconfirmed'; disposition: 'held'; reason: string };\n\nexport function persistDisposition(result: DispositionWrite): DispositionWrite {\n  return result;\n}\n`;
    const oldBoundary = source.replace(
      'export function persistDisposition(result: DispositionWrite): DispositionWrite {\n  return result;\n}',
      "export function persistDisposition(result: DispositionWrite): void {\n  if (result.kind !== 'recorded') throw new Error(result.reason);\n}",
    );

    expect(
      compositionViolations(
        fixtureContext(oldBoundary, [{ key: 'subject.ts#DispositionWrite', undecided: ['unconfirmed'] }]),
      ).map(({ boundary }) => boundary),
    ).toContain('subject.ts#persistDisposition');
    expect(
      compositionViolations(
        fixtureContext(source, [{ key: 'subject.ts#DispositionWrite', undecided: ['unconfirmed'] }]),
      ),
    ).toEqual([]);
  });

  it('rejects leader-only and mismatched-group settlement of a retained process-group obligation', () => {
    const path = 'src/infra/group-absence-evidence-control.ts';
    const leaderNegativePath = 'src/infra/group-leader-evidence-negative-control.ts';
    const mismatchNegativePath = 'src/infra/group-identity-mismatch-negative-control.ts';
    const source = readFileSync(resolve(FIXTURE_ROOT, 'group-absence-evidence.ts.txt'), 'utf8').replaceAll(
      '../../../../src/',
      '../',
    );
    const leaderOnlySettlement = source
      .replace(
        '  evidence: RoleSpawnAbsenceEvidence<RetainedProcessGroupSubject>,',
        "  evidence: RoleSpawnAbsenceEvidence<Extract<RoleSpawnCleanupSubject, { kind: 'process' }>>,",
      )
      .replace(
        '  evidence: ProviderServerFailedSpawnAbsenceEvidence<4_132>,',
        "  evidence: RoleSpawnAbsenceEvidence<Extract<RoleSpawnCleanupSubject, { kind: 'process' }>>,",
      );
    const mismatchedGroupSettlement = source
      .replace(
        '  evidence: RoleSpawnAbsenceEvidence<RetainedProcessGroupSubject>,',
        '  evidence: RoleSpawnAbsenceEvidence<MismatchedProcessGroupSubject>,',
      )
      .replace(
        '  evidence: ProviderServerFailedSpawnAbsenceEvidence<4_132>,',
        '  evidence: ProviderServerFailedSpawnAbsenceEvidence<4_133>,',
      );

    const program = productionProgram(
      new Map([
        [path, source],
        [leaderNegativePath, leaderOnlySettlement],
        [mismatchNegativePath, mismatchedGroupSettlement],
      ]),
    );
    expect(diagnosticsFor(program, path)).toEqual([]);
    expect(diagnosticsFor(program, leaderNegativePath)).toEqual([expect.stringMatching(/TS2741:/u)]);
    expect(diagnosticsFor(program, mismatchNegativePath)).toEqual([
      expect.stringMatching(/TS2322:/u),
      expect.stringMatching(/TS2322:/u),
    ]);
  });

  it('rejects registry entries without a distinct discriminator or their named undecided answer', () => {
    const source = readFileSync(resolve(FIXTURE_ROOT, 'subject.ts.txt'), 'utf8');
    expect(() => fixtureContext(source, [{ key: 'subject.ts#Observation', undecided: ['uninspectable'] }])).toThrow(
      'undecided answers are not discriminants',
    );
    const duplicateDiscriminants = `${source}\nexport type DuplicateObservation =\n  | { kind: 'same'; one: 1 }\n  | { kind: 'same'; two: 2 }\n  | { kind: 'same'; three: 3 };\n`;
    expect(() =>
      fixtureContext(duplicateDiscriminants, [{ key: 'subject.ts#DuplicateObservation', undecided: ['same'] }]),
    ).toThrow('does not carry three distinctly discriminated answers');

    const undiscriminated = `${source}\nexport type UndiscriminatedObservation =\n  | { one: 1 }\n  | { two: 2 }\n  | { three: 3 };\n`;
    expect(() =>
      fixtureContext(undiscriminated, [{ key: 'subject.ts#UndiscriminatedObservation', undecided: [] }]),
    ).toThrow('does not carry three distinctly discriminated answers');
  });

  it('rejects an allowlist entry after its boundary becomes compliant', () => {
    const source = readFileSync(resolve(FIXTURE_ROOT, 'subject.ts.txt'), 'utf8');
    const legacy = source.replace(
      'export function translate(observation: Observation): Observation {\n  return observation;\n}',
      'export function translate(observation: Observation): void {\n  void observation;\n}',
    );
    const allowlist = new Map([
      ['subject.ts#translate', debt('legacy boundary has no returned disposition', 'translate returns Observation')],
    ]);
    expect(enforceDebts(compositionViolations(fixtureContext(legacy)), allowlist)).toEqual([]);
    expect(enforceDebts(compositionViolations(fixtureContext(source)), allowlist)).toEqual([
      'subject.ts#translate: stale allowlist entry (legacy boundary has no returned disposition)',
    ]);
  });
});
