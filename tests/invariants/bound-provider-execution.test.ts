import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { none } from '#src/providers/capability.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { buildExactProviderEnv } from '#src/providers/execution-context.js';
import { JobLaunchService } from '#src/coordinator/services/job-launch.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { fixtureProviderBindingCodec, type FixtureProviderSource } from '#tests/helpers/provider-binding.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const ROOT = new URL('../../', import.meta.url);
const REPO_ROOT = ROOT.pathname;
const PRODUCTION_FILES = listProductionSourceFiles(new URL('src/', ROOT).pathname);
const PRODUCTION_EDGES = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILES, PRODUCTION_FILES);
const PROVIDER_VERTICAL_NAMES = new Set(
  PRODUCTION_FILES.flatMap((file) => {
    const match = /^src\/providers\/([^/]+)\/definition\.ts$/u.exec(toCanonicalSrcPath(REPO_ROOT, file));
    return match?.[1] === undefined ? [] : [match[1]];
  }),
);

function providerVerticalName(path: string): string | undefined {
  const match = /^src\/providers\/([^/]+)\//u.exec(path);
  return match?.[1] !== undefined && PROVIDER_VERTICAL_NAMES.has(match[1]) ? match[1] : undefined;
}

const GENERIC_EXECUTION_FILES = [
  'src/coordinator/services/job-launch.ts',
  'src/coordinator/services/recovery/actions.ts',
  'src/coordinator/services/recovery/index.ts',
  'src/coordinator/services/recovery/service.ts',
  'src/jobs/contracts/job-runner.ts',
  'src/jobs/shell/launch.ts',
  'src/sessions/artifact-discard.ts',
  'src/sessions/lifecycle-reactor.ts',
] as const;

describe('bound-provider execution architecture', () => {
  it('keeps provider-name interpretation out of generic execution code', () => {
    const violations = GENERIC_EXECUTION_FILES.flatMap((path) => {
      const source = readFileSync(new URL(path, ROOT), 'utf-8');
      return /['"](?:claude|codex)['"]/u.test(source) ? [path] : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps app-server runtime metadata provider-neutral across persistence and recovery', () => {
    const violations = PRODUCTION_FILES.flatMap((file) => {
      const path = toCanonicalSrcPath(REPO_ROOT, file);
      if (!path.startsWith('src/jobs/') && !path.startsWith('src/coordinator/services/recovery/')) return [];
      return /\bclaudeTransport\b/u.test(readFileSync(file, 'utf-8')) ? [path] : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps every provider vertical private behind its inert definition', () => {
    const violations = PRODUCTION_EDGES.flatMap(({ source, target }) => {
      const targetProvider = providerVerticalName(target);
      if (targetProvider === undefined) return [];
      if (providerVerticalName(source) === targetProvider) return [];
      if (source === 'src/providers/bootstrap.ts' && target === `src/providers/${targetProvider}/definition.ts`) {
        return [];
      }
      return [`${source} -> ${target}`];
    });

    expect(violations).toEqual([]);

    const bootstrap = readFileSync(new URL('src/providers/bootstrap.ts', ROOT), 'utf-8');
    expect(bootstrap).not.toMatch(
      /(?:ExecutionContext|Preflight|Recovery|Artifact|Curation|BindingCodec|ProviderTerminal)/u,
    );
    expect(bootstrap).not.toMatch(/\.\/(?:claude|codex)\/(?!definition\.js)/u);
  });

  it('keeps provider implementations out of shared provider-root modules', () => {
    const violations = PRODUCTION_FILES.flatMap((file) => {
      const path = toCanonicalSrcPath(REPO_ROOT, file);
      if (!/^src\/providers\/[^/]+\.ts$/u.test(path) || path === 'src/providers/bootstrap.ts') return [];
      return /claude|codex/iu.test(readFileSync(file, 'utf-8')) ? [path] : [];
    });

    expect(violations).toEqual([]);
  });

  it('does not let generic coordinators read provider credential routing or private execution contexts', () => {
    const violations = PRODUCTION_FILES.flatMap((file) => {
      const path = toCanonicalSrcPath(REPO_ROOT, file);
      if (!/^src\/(?:coordinator|jobs|sessions|workflow|discuss)\//u.test(path)) return [];
      const source = readFileSync(file, 'utf-8');
      return /\.credentialSource\s*\(\)/u.test(source) || /providers\/(?:claude|codex)\/execution-context/u.test(source)
        ? [path]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('does not restore the removed public execution union or executable definition contract', () => {
    const contract = readFileSync(new URL('src/providers/contract.ts', ROOT), 'utf-8');
    const registry = readFileSync(new URL('src/providers/registry.ts', ROOT), 'utf-8');

    expect(contract).not.toContain('ProviderExecutionContext');
    expect(contract).not.toContain('ProviderSpec');
    expect(registry).toMatch(/export type ProviderDefinition = \{\s*readonly name: string;/u);
    expect(registry).not.toMatch(/export type ProviderDefinition[^;]+readonly run:/su);
  });

  it('does not restore removed credential-source modules, imports, or execution aliases', () => {
    const removedCredentialSources = new URL('src/infra/provider-credential-sources.ts', ROOT);
    const obsoleteAuthorityNames =
      /\b(?:ProviderCredentialSourceRef|RehydratedProviderBinding|ProviderSpec|ProviderExecutionContext|providerCredentialDefaults|providerCredentialSourceForRecovery)\b/u;
    const violations = PRODUCTION_FILES.flatMap((file) => {
      const source = readFileSync(file, 'utf-8');
      return /provider-credential-sources/u.test(source) || obsoleteAuthorityNames.test(source)
        ? [toCanonicalSrcPath(REPO_ROOT, file)]
        : [];
    });

    expect(existsSync(removedCredentialSources)).toBe(false);
    expect(violations).toEqual([]);
  });

  it('keeps opaque provider sources and process compilation outside shared execution infrastructure', () => {
    const bindingContract = readFileSync(new URL('src/providers/contracts/binding.ts', ROOT), 'utf-8');
    const providerContract = readFileSync(new URL('src/providers/contract.ts', ROOT), 'utf-8');
    const runtimePorts = readFileSync(new URL('src/infra/port-types.ts', ROOT), 'utf-8');
    const registry = readFileSync(new URL('src/providers/registry.ts', ROOT), 'utf-8');
    const executionContext = readFileSync(new URL('src/providers/execution-context.ts', ROOT), 'utf-8');
    const durableTransport = readFileSync(new URL('src/coordinator/live/durable-transport.ts', ROOT), 'utf-8');
    const serverTransport = readFileSync(new URL('src/coordinator/live/provider-server-transport.ts', ROOT), 'utf-8');
    const realRuntime = readFileSync(new URL('src/runtime/real.ts', ROOT), 'utf-8');

    expect(bindingContract).not.toContain('ProviderCredentialSourceRef');
    expect(providerContract).not.toContain('ProviderCredentialSourceRef');
    expect(providerContract).not.toContain('claudeConfigDir');
    expect(runtimePorts).not.toContain('claudeConfigDir');
    expect(registry).not.toContain('providerCredentialSourceRefSchema');
    expect(executionContext).not.toContain('providerRoutingEnv');
    expect(executionContext).not.toMatch(/CLAUDE|CODEX/u);
    expect(durableTransport).not.toContain('windowsCommandName');
    expect(serverTransport).not.toContain('windowsCommandName');
    expect(realRuntime).not.toMatch(/normalized\s*===\s*['"](?:claude|codex)['"]/u);
  });

  it('keeps durable recovery interpretation behind the bound provider authority', () => {
    const actions = readFileSync(new URL('src/coordinator/services/recovery/actions.ts', ROOT), 'utf-8');
    const recoveryIndex = readFileSync(new URL('src/coordinator/services/recovery/index.ts', ROOT), 'utf-8');
    const recoveryService = readFileSync(new URL('src/coordinator/services/recovery/service.ts', ROOT), 'utf-8');
    const recoveryContracts = readFileSync(new URL('src/jobs/reconcile/contracts.ts', ROOT), 'utf-8');
    const executionService = readFileSync(new URL('src/coordinator/execution-service.ts', ROOT), 'utf-8');

    expect(recoveryContracts).toContain('ProviderRecoveryAuthority');
    expect(actions).toContain('authority: ProviderRecoveryAuthority');
    expect(actions).not.toContain('ProviderRecoveryContract');
    expect(actions).not.toMatch(/finalizeFromArtifacts\(\{[^}]*\bsource\s*:/su);
    expect(actions).not.toContain("kind: 'provider_exit'");
    expect(actions).not.toContain('recoveryAuthorityLaunch');
    expect(actions).not.toContain('providerRegistry');
    const markErrorStart = actions.indexOf("case 'markError':");
    const registerQueuedStart = actions.indexOf("case 'registerQueued':");
    expect(markErrorStart).toBeGreaterThanOrEqual(0);
    expect(registerQueuedStart).toBeGreaterThan(markErrorStart);
    const markErrorBranch = actions.slice(markErrorStart, registerQueuedStart);
    expect(markErrorBranch).not.toContain('captureProviderRecoveryAuthority');
    expect(markErrorBranch).not.toContain('readLaunchProjection');
    expect(recoveryIndex).not.toContain('captureProviderRecoveryAuthority');
    expect(recoveryIndex).not.toContain('readProviderSession');
    expect(recoveryService.match(/await this\.readProviderSession\(/gu)).toHaveLength(1);
    expect(recoveryContracts).not.toContain('validateProviderRecoveryAuthority');
    expect(recoveryContracts).not.toContain('boundProviderForRecovery');
    expect(recoveryContracts).not.toContain('providerCredentialSourceForRecovery');
    expect(executionService).not.toContain('providerCredentialSourceForRecovery');
  });

  it('launches a newly registered fixture provider through generic job launch and orchestration', async () => {
    let dispatched = false;
    let prepared = false;
    let observedSource: FixtureProviderSource | undefined;
    let observedCliEnv: Readonly<Record<string, string>> | undefined;
    const definition = defineProvider<FixtureProviderSource, FixtureProviderSource>({
      name: 'fixture',
      prepareExecutionContext: ({ source, request, baseEnv, protectedEnv, platform }) => {
        prepared = true;
        observedSource = source;
        const exactEnv = buildExactProviderEnv({
          baseEnv,
          requestEnv: request.coralEnv,
          protectedEnv,
          routingEnv: source.routingEnv,
          allowedRequestKeys: new Set(['FIXTURE_TUNING']),
          platform,
        });
        return {
          context: source,
          prepareCliRequest: (cliRequest) => ({ ...cliRequest, exactEnv: { ...exactEnv } }),
        };
      },
      run: async function* (_request, runtime) {
        dispatched = true;
        await runtime.runCli({ command: 'fixture', args: ['--run'] });
        yield {
          kind: 'terminal' as const,
          terminal: { content: 'fixture-result', durationMs: 0, outcome: { kind: 'completed' as const } },
          diagnostics: {},
        };
      },
    })
      .binding(fixtureProviderBindingCodec('fixture'))
      .artifacts(none('fixture provider has no native artifacts'))
      .build();
    const providers = new ProviderRegistry();
    providers.register(definition);
    const runtime = new SimulationRuntime();
    const abortRegistry = new AbortRegistry(runtime.ids);
    let storedSession: ProviderSession | null = null;
    let releaseCompleted!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseCompleted = resolve;
    });
    const sessionManager = {
      prepare(options: {
        binding: ProviderSession['binding'];
        name: string;
        cwd: string;
        projectRoot: string;
        backendNamespace: string;
      }): ProviderSession {
        storedSession = {
          sessionId: 'fixture-session',
          binding: options.binding,
          name: options.name,
          state: 'ready',
          retention: 'retain',
          artifactHandles: [],
          retentionDiscard: { attempts: [] },
          cwd: options.cwd,
          projectRoot: options.projectRoot,
          backendNamespace: options.backendNamespace,
          providerContinuity: null,
          createdAt: '2026-07-22T00:00:00.000Z',
          lastUsedAt: '2026-07-22T00:00:00.000Z',
          version: 0,
        };
        return storedSession;
      },
      appendPreparedClaim(_commit: unknown, preparedSession: ProviderSession, jobId: string): ProviderSession {
        storedSession = { ...preparedSession, activeJobId: jobId, version: preparedSession.version + 1 };
        return storedSession;
      },
      observeCommittedEntry(entry: ProviderSession) {
        storedSession = entry;
      },
      get(provider: string, sessionId: string) {
        return storedSession?.binding.provider === provider && storedSession.sessionId === sessionId
          ? storedSession
          : null;
      },
      async checkpointJobContinuityAtomic() {
        return { ok: false as const };
      },
      async recordArtifactHandleAtomic() {
        return { ok: false as const };
      },
      async releaseJobClaimAtomic() {
        if (storedSession !== null) {
          const { activeJobId: _activeJobId, ...releasedSession } = storedSession;
          storedSession = { ...releasedSession, version: storedSession.version + 1 };
        }
        releaseCompleted();
        return true;
      },
      releaseJob() {},
    };
    const appended: unknown[] = [];
    const terminalCalls: unknown[] = [];
    const coordinatorCommit = (callback: (commit: unknown) => undefined) => {
      callback({ append: (event: unknown) => (appended.push(event), {}) });
      return [];
    };
    const progressStore = {
      nextEnqueueSequence: () => 1,
      readLaunchProjection: () => null,
      readStatus: () => null,
      jobDir: (jobId: string) => `/tmp/${jobId}`,
      appendProgress() {},
      appendRuntimeStarted() {},
      commit() {},
    };
    const jobPools = new Map();
    const orchestrator = new LaunchOrchestrator({
      abortRegistry,
      progressStore: progressStore as never,
      sessionManager: sessionManager as never,
      launchAdmission: {
        requestLaunch: () => ({ type: 'immediate' as const }),
        releaseLaunch() {},
        cancelQueued: () => false,
      },
      durableSpawner: {
        async spawnDurableJob(options: { exactEnv?: Record<string, string> }) {
          observedCliEnv = options.exactEnv;
          return { stdout: '', stderr: '', code: 0, aborted: false };
        },
      } as never,
      providerRegistry: providers,
      runtime,
      coordinatorCommit: coordinatorCommit as never,
      backendNamespace: 'fixture-backend',
      bundleHash: 'fixture-bundle',
      jobPools,
      terminalMaterializer: {
        recordProviderTerminal(_store: unknown, event: unknown, metadata: unknown) {
          terminalCalls.push({ event, metadata });
        },
      },
      acquireServer: async () => {
        throw new Error('Fixture provider does not use an app server.');
      },
    });
    const service = new JobLaunchService({
      runtime,
      sessionManager: sessionManager as never,
      backendNamespace: 'fixture-backend',
      bundleHash: 'fixture-bundle',
      providerRegistry: providers,
      pluginRegistry: { discoverPluginRoot: () => null },
      progressStore: progressStore as never,
      launchOrchestrator: orchestrator,
      childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
    });

    expect(Object.keys(definition)).toEqual(['name']);
    const decision = await service.start(
      'fixture',
      { prompt: 'run', cwd: '/fixture', jobId: 'fixture-job' },
      {
        projectRoot: '/fixture',
        pluginRoot: '/plugin',
        coralEnv: { FIXTURE_TUNING: 'precise', CORAL_CLAUDE_MODEL_CAP: 'must-not-leak' },
        principal: testProjectPrincipal('/fixture'),
        providerScope: {
          origin: 'caller',
          profiles: [{ provider: 'fixture', profile: { canonicalLocation: '/fixture', routing: {} } }],
        },
      },
    );
    await released;

    expect(decision).toEqual({
      kind: 'provider-session',
      status: 'running',
      jobId: 'fixture-job',
      sessionId: 'fixture-session',
    });
    expect(prepared).toBe(true);
    expect(observedSource).toEqual({
      root: '/fixture',
      routingEnv: { FIXTURE_PROFILE_ROOT: '/fixture' },
    });
    expect(observedCliEnv).toMatchObject({
      FIXTURE_PROFILE_ROOT: '/fixture',
      FIXTURE_TUNING: 'precise',
    });
    expect(observedCliEnv).not.toHaveProperty('CORAL_CLAUDE_MODEL_CAP');
    expect(dispatched).toBe(true);
    expect(appended).toEqual([
      expect.objectContaining({
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'fixture-job' },
        refs: expect.objectContaining({ jobId: 'fixture-job', sessionId: 'fixture-session' }),
        body: expect.objectContaining({
          sessionId: 'fixture-session',
          provider: 'fixture',
        }),
      }),
      expect.objectContaining({
        type: 'job.queue.admitted',
        stream: { kind: 'job', id: 'fixture-job' },
        refs: expect.objectContaining({ jobId: 'fixture-job', sessionId: 'fixture-session' }),
        body: { queuePosition: 0 },
      }),
    ]);
    expect(terminalCalls).toEqual([
      {
        event: {
          kind: 'terminal',
          terminal: { content: 'fixture-result', durationMs: 0, outcome: { kind: 'completed' } },
          diagnostics: {},
        },
        metadata: expect.objectContaining({
          jobId: 'fixture-job',
          sessionId: 'fixture-session',
          namespace: 'fixture-backend',
          project: '/fixture',
        }),
      },
    ]);
    expect(storedSession).toMatchObject({
      sessionId: 'fixture-session',
      binding: expect.objectContaining({ provider: 'fixture' }),
    });
    expect(storedSession).not.toHaveProperty('activeJobId');
    expect(jobPools.has('fixture-job')).toBe(false);
  });
});
