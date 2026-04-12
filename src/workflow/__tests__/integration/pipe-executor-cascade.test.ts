import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentRef, resolveAgent } from '../../../execution/agent-resolution.js';
import { LaunchCoordinator } from '../../../execution/engine.js';
import { TypedEventBus } from '../../../execution/event-bus.js';
import { createProviderHostManager } from '../../../execution/host-manager.js';
import { ProgressStore } from '../../../execution/progress-store.js';
import { createRealRuntime } from '../../../execution/runtime.js';
import { ExecutionService } from '../../../execution/service.js';
import { pluginRootNamespace } from '../../../infra/paths.js';
import { ProviderRegistry } from '../../../providers/registry.js';
import type { Provider } from '../../../providers/types.js';
import type { CallerContext } from '../../../shared/request-context.js';
import type { ProviderInstruction, ProviderRequest } from '../../../shared/types.js';

type RecordedLaunchRequest = ProviderRequest & {
  instruction?: ProviderInstruction;
};

function cloneProviderRequest(request: ProviderRequest): RecordedLaunchRequest {
  return {
    ...request,
    coralEnv: { ...request.coralEnv },
    ...(request.instruction ? { instruction: { ...request.instruction } } : {}),
  };
}

describe('pipe executor coral cascade invariant', () => {
  it('forces coral workflow atoms to resolve from the coral plugin instead of the project override', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const SENTINEL_PROJECT = 'SENTINEL_PROJECT_' + suffix;
    const SENTINEL_CORAL = 'SENTINEL_CORAL_' + suffix;

    const projectRoot = mkdtempSync(join(tmpdir(), 'pipe-cascade-proj-'));
    const coralPluginRoot = mkdtempSync(join(tmpdir(), 'pipe-cascade-coral-'));

    try {
      const projectArchitectPath = join(projectRoot, '.claude', 'agents', 'architect.md');
      const coralArchitectPath = join(coralPluginRoot, 'agents', 'architect.md');

      mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
      mkdirSync(join(coralPluginRoot, 'agents'), { recursive: true });
      writeFileSync(projectArchitectPath, '---\n---\n' + SENTINEL_PROJECT);
      writeFileSync(coralArchitectPath, '---\n---\n' + SENTINEL_CORAL);

      expect(projectRoot).not.toBe(coralPluginRoot);
      expect(existsSync(projectArchitectPath)).toBe(true);
      expect(existsSync(coralArchitectPath)).toBe(true);
      expect(readFileSync(projectArchitectPath, 'utf8')).toContain(SENTINEL_PROJECT);
      expect(readFileSync(coralArchitectPath, 'utf8')).toContain(SENTINEL_CORAL);
      const runtime = createRealRuntime();

      const resolutionCtx = {
        projectRoot,
        coralPluginRoot,
        discoverPluginRoot: () => null,
        storage: runtime.storage,
      };

      const bareResolved = resolveAgent(parseAgentRef('architect'), resolutionCtx);
      expect(bareResolved.content).toContain(SENTINEL_PROJECT);
      expect(bareResolved.content).not.toContain(SENTINEL_CORAL);
      expect(bareResolved.path.startsWith(projectRoot)).toBe(true);

      const forcedResolved = resolveAgent(parseAgentRef('coral:architect'), resolutionCtx);
      expect(forcedResolved.path.startsWith(join(coralPluginRoot, 'agents') + sep)).toBe(true);
      expect(forcedResolved.content).toContain(SENTINEL_CORAL);
      expect(forcedResolved.content).not.toContain(SENTINEL_PROJECT);

      const capturedLaunches: RecordedLaunchRequest[] = [];
      const stubProvider: Provider = {
        name: 'stub-provider',
        execute: async (request) => {
          capturedLaunches.push(cloneProviderRequest(request));
          return { content: 'stub-provider-result' };
        },
      };

      const providerRegistry = new ProviderRegistry();
      providerRegistry.register(stubProvider);

      const eventBus = new TypedEventBus();
      const executionSvc = new ExecutionService(
        { projectRoot, pluginRoot: coralPluginRoot, coralEnv: {} },
        {
          runtime,
          progressStore: new ProgressStore('test-ns', eventBus, runtime),
          bundleHash: 'pipe-executor-cascade-test',
          backendNamespace: pluginRootNamespace(coralPluginRoot),
          providerHostManager: createProviderHostManager({
            runtime,
            spawnProviderServer: async () => {
              throw new Error('Provider host manager should not be used in pipe executor cascade test');
            },
          }),
          launchCoordinator: new LaunchCoordinator({ runtime }),
          eventBus,
          providerRegistry,
          pluginRegistry: { discoverPluginRoot: () => null },
        },
      );

      const ctx: CallerContext = { projectRoot, pluginRoot: coralPluginRoot, coralEnv: {} };
      const decision = await executionSvc.coralDispatch(
        'stub-provider',
        'architect',
        { prompt: 'hi', cwd: projectRoot },
        ctx,
      );

      expect(decision.status).toBe('running');
      expect(capturedLaunches).toHaveLength(1);

      const [launch] = capturedLaunches;
      expect(launch.instruction).toBeDefined();
      if (!launch.instruction) {
        throw new Error('Expected coralDispatch launch to include a resolved instruction');
      }
      expect(launch.instruction.content).toContain(SENTINEL_CORAL);
      expect(launch.instruction.content).not.toContain(SENTINEL_PROJECT);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(coralPluginRoot, { recursive: true, force: true });
    }
  });
});
