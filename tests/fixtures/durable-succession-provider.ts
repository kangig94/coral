import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BackendAlreadyRunningError } from '#src/coordinator/handoff.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import { installSuccessionAttemptChild, receiveSuccessionAttemptChild } from '#src/coordinator/succession/attempt-child.js';
import { probeRetainedEpochOpen, runRetainedEpochRecovery } from '#src/coordinator/succession/retained-epoch-executor.js';
import { resolveStrictBundleIdentity } from '#src/infra/bundle-manifest.js';
import { runKbDaemonMain } from '#src/kb-daemon/daemon-main.js';
import { claudeArtifactCapability } from '#src/providers/claude/artifacts.js';
import { claudeBindingCodec } from '#src/providers/claude/binding.js';
import { codexProviderDefinition } from '#src/providers/codex/definition.js';
import type { ProviderExecutionPlan } from '#src/providers/execution-plan.js';
import { defineProvider } from '#src/providers/registry.js';
import { providerProgressEvent, providerTerminalEvent, streamProviderEvents } from '#src/providers/stream.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

declare const __PLUGIN_ROOT__: string;

type TestPlan = ProviderExecutionPlan<{ script: string }, Record<string, never>, Record<string, never>>;

const durableClaude = defineProvider<TestPlan, ReturnType<typeof claudeBindingCodec.access>>({
  name: 'claude',
  transport: 'standalone',
  prepareExecutionPlan: (input) => ({
    plan: {
      host: { script: join(__PLUGIN_ROOT__, 'fixtures', 'gated-durable-cli.cjs') },
      session: {},
      turn: {},
    },
    prepareCliRequest: (request) => ({
      ...request,
      exactEnv: { ...input.baseEnv, ...input.request.coralEnv, ...input.protectedEnv },
      extraEnv: undefined,
    }),
  }),
  run: (request, runtime) => streamProviderEvents(async (emit) => {
    const result = await runtime.runCli({
      command: process.execPath,
      args: [
        runtime.executionPlan.host.script,
        join(request.cwd, '.durable-state', request.coralEnv.CORAL_JOB_ID ?? 'missing'),
        join(__PLUGIN_ROOT__, 'bridge', 'coral-cli'),
      ],
      onEvent: (line) => emit(providerProgressEvent(line, new Date().toISOString())),
    });
    emit(providerTerminalEvent({
      content: result.stdout,
      durationMs: 0,
      outcome: result.aborted
        ? { kind: 'aborted', reason: 'user_abort' }
        : result.code === 0
          ? { kind: 'completed' }
          : { kind: 'provider_exit', code: result.code ?? -1 },
    }));
  }),
  recovery: {
    finalizeInterrupted: () => ({ kind: 'clear_non_resumable' }),
    finalizeFromArtifacts: async ({ stdoutPath, storage }) => {
      const content = storage.readFileSync(stdoutPath, 'utf-8');
      return {
        terminal: providerTerminalEvent({
          content,
          durationMs: 0,
          outcome: content.includes('cancelled by successor')
            ? { kind: 'aborted', reason: 'user_abort' }
            : { kind: 'completed' },
        }),
      };
    },
    extractProgress: ({ stdoutPath, fromOffset }) => {
      const output = readFileSync(stdoutPath);
      return {
        messages: output.subarray(fromOffset).toString('utf8').split('\n').filter(Boolean),
        newOffset: output.length,
      };
    },
  },
})
  .binding(claudeBindingCodec)
  .artifacts(claudeArtifactCapability)
  .build();

async function main(): Promise<void> {
  if (process.argv.includes('--print-store-format-fingerprint')) {
    process.stdout.write(`${currentCoralStoreFormat().fingerprint}\n`);
    return;
  }
  if (process.argv.includes('--print-store-reset-build-identity')) {
    const identity = resolveStrictBundleIdentity();
    if (!identity.ok) {
      process.exitCode = 70;
      return;
    }
    process.stdout.write(`${JSON.stringify(identity.manifest)}\n`);
    return;
  }
  if (process.argv.length === 4 && process.argv[2] === '--recover-retained-epoch') {
    process.exitCode = runRetainedEpochRecovery(process.argv[3]!);
    return;
  }
  if (process.argv.length === 5 && process.argv[2] === '--probe-retained-epoch') {
    process.exitCode = probeRetainedEpochOpen(process.argv[3]!, process.argv[4]!);
    return;
  }
  if (process.env.CORAL_KB_DAEMON === '1') {
    process.exitCode = await runKbDaemonMain({ pluginRoot: __PLUGIN_ROOT__ });
    return;
  }
  const keepalive = setInterval(() => {}, 60_000);
  try {
    const attempt = await receiveSuccessionAttemptChild();
    installSuccessionAttemptChild(attempt);
    const coordinator = createCoordinatorServer({
      pluginRoot: __PLUGIN_ROOT__,
      ...(attempt === null ? {} : { bootSnapshot: { bootToken: attempt.bootToken } }),
      registerBuiltInProvidersFn: (registry) => {
        registry.register(codexProviderDefinition);
        registry.register(durableClaude);
      },
      onStopped: () => process.exit(0),
      onFatalShutdownError: (error) => {
        process.stderr.write(`${String(error)}\n`);
        process.exit(1);
      },
    });
    process.on('SIGTERM', () => {
      void coordinator.shutdown('sigterm');
    });
    try {
      await coordinator.start();
    } catch (error) {
      if (!(error instanceof BackendAlreadyRunningError)) throw error;
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    clearInterval(keepalive);
  }
}

void main();
