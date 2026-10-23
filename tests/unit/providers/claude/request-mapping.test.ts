import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildClaudeBootstrapSignature, mapSessionEnsureParams } from '#src/providers/claude/request-mapping.js';
import { sameBootstrapSignature } from '#src/providers/claude/request-prep.js';
import { buildClaudeExecutionPlan } from '#src/providers/claude/execution-plan.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';
import { TEST_CLAUDE_ACCESS } from '#tests/helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { CORAL_CLAUDE_TRANSPORT_ENV } from '#src/providers/claude/transport-mode.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function withPluginRoot<T>(run: () => T): T {
  vi.stubGlobal('__PLUGIN_ROOT__', '/plugin');
  return run();
}

function prepareBroker(options: {
  cwd?: string;
  coralEnv?: Record<string, string>;
  baseEnv?: Record<string, string>;
  existsSync?: (path: string) => boolean;
}) {
  const input = {
    access: TEST_CLAUDE_ACCESS,
    request: {
      action: 'exec',
      jobId: 'session',
      prompt: 'test',
      cwd: fixtureCanonicalWorkDir(options.cwd ?? '/workspace'),
      bypassPermissions: false,
      coralEnv: options.coralEnv ?? {},
    },
    baseEnv: options.baseEnv ?? {},
    storage: { existsSync: options.existsSync ?? (() => true) },
    platform: 'linux',
  } as const;
  const hostPlan = claudeAppServerLifecycle.planHost({ hostRoot: '/plugin/bridge', purpose: 'execution', ...input });
  buildClaudeExecutionPlan({ ...input, hostPlan });
  return claudeAppServerLifecycle.compileStableHost(hostPlan);
}

describe('Claude appserver request mapping', () => {
  it('keeps one bootstrap signature when a later execution resumes the same conversation', () => {
    const ids = { sha256: () => 'system-hash' };
    const cwd = fixtureCanonicalWorkDir('/workspace');
    const signature = (resumeConversation: boolean, changedCwd = false) =>
      buildClaudeBootstrapSignature(
        { cwd: changedCwd ? fixtureCanonicalWorkDir('/elsewhere') : cwd, bypassPermissions: false },
        ids,
        { derivedSystemPrompt: 'system', conversationRef: 'conversation-1', projectsRoot: '/projects', model: 'opus' },
      );
    const opened = signature(false);
    const ensureResume = mapSessionEnsureParams(
      {
        action: 'resume',
        jobId: 'job-1',
        cwd,
        bypassPermissions: false,
        conversationRef: 'conversation-1',
        coralEnv: {},
        model: 'opus',
      },
      ids,
      { derivedSystemPrompt: 'system', controllerEnv: {}, projectsRoot: '/projects' },
    );
    expect(ensureResume.resumeExisting).toBe(true);
    expect(sameBootstrapSignature(opened, ensureResume)).toBe(true);
    expect(sameBootstrapSignature(opened, signature(true, true))).toBe(false);
  });

  it('defaults the Claude broker transport to print mode in provider server identity', () => {
    const spec = withPluginRoot(() => prepareBroker({}));

    expect(spec.env).toEqual({ [CORAL_CLAUDE_TRANSPORT_ENV]: 'print' });
    expect(spec.env).toMatchObject({ CORAL_CLAUDE_TRANSPORT: 'print' });
  });

  it('carries explicit TUI transport into provider server identity', () => {
    const spec = withPluginRoot(() => prepareBroker({ coralEnv: { [CORAL_CLAUDE_TRANSPORT_ENV]: 'tui' } }));

    expect(spec.env).toEqual({ [CORAL_CLAUDE_TRANSPORT_ENV]: 'tui' });
    expect(spec.env).toMatchObject({ CORAL_CLAUDE_TRANSPORT: 'tui' });
  });

  it('keeps one account-neutral broker while binding each controller to its Claude account', () => {
    const brokerA = withPluginRoot(() => prepareBroker({ baseEnv: { PATH: '/bin' } }));
    const brokerB = withPluginRoot(() => prepareBroker({ baseEnv: { PATH: '/bin' } }));
    const ensureA = mapSessionEnsureParams(
      {
        action: 'exec',
        jobId: 'session-a',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {},
      },
      { sha256: () => 'system-hash' },
      {
        controllerEnv: { CLAUDE_CONFIG_DIR: '/accounts/a' },
        projectsRoot: '/accounts/a/projects',
      },
    );
    const ensureB = mapSessionEnsureParams(
      {
        action: 'exec',
        jobId: 'session-b',
        cwd: fixtureCanonicalWorkDir('/workspace'),
        bypassPermissions: false,
        coralEnv: {},
      },
      { sha256: () => 'system-hash' },
      {
        controllerEnv: { CLAUDE_CONFIG_DIR: '/accounts/b' },
        projectsRoot: '/accounts/b/projects',
      },
    );

    expect(brokerA).toEqual(brokerB);
    expect(brokerA.leaseMode).toBe('shared');
    expect(brokerA.idleRetirement).toBe('unleased-and-host-idle');
    expect(brokerA.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(brokerA.env).not.toHaveProperty('CORAL_CHILD_PRINCIPAL_HANDLE');
    expect(brokerA.env).not.toHaveProperty('CORAL_JOB_ID');
    expect(brokerA.env).not.toHaveProperty('CORAL_SESSION_ID');
    expect(ensureA.controllerEnv).toMatchObject({ CLAUDE_CONFIG_DIR: '/accounts/a' });
    expect(ensureA.projectsRoot).toBe('/accounts/a/projects');
    expect(ensureB.controllerEnv).toMatchObject({ CLAUDE_CONFIG_DIR: '/accounts/b' });
    expect(ensureB.projectsRoot).toBe('/accounts/b/projects');
  });
});
