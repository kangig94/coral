declare const __PLUGIN_ROOT__: string;
declare const __BUNDLE_DIR__: string | undefined;

import { join } from 'node:path';

import { isRecord, readString } from '../../infra/json.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { IdPort } from '../../runtime/ports.js';
import type { ProviderRequest, ProviderServerSpec } from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { SessionEnsureParams, TurnInterruptParams, TurnStartParams } from './appserver/protocol.js';
import {
  hashSortedEnv,
  hashClaudeBootstrapConfiguration,
  normalizeControllerEnv,
  readBootstrapSignature,
  type ClaudeBootstrapSignature,
  type PermissionMode,
} from './request-prep.js';
import type { resolveClaudeTransportMode } from './transport-mode.js';

export interface ClaudePersistedContinuity extends ProviderContinuityBlob {
  bootstrapSignature?: ClaudeBootstrapSignature;
  brokerSessionKey?: string;
  brokerTurnId?: string;
}

export type ClaudeBrokerHostPlan = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  transportMode: ReturnType<typeof resolveClaudeTransportMode>;
}>;

let envHashCache: {
  controllerEnv: Record<string, string> | undefined;
  baseEnv: Readonly<Record<string, string>>;
  hash: string;
} | null = null;

export function readClaudePersistedContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): ClaudePersistedContinuity {
  if (!isRecord(persistedContinuity)) {
    return {};
  }

  const bootstrapSignature = readBootstrapSignature(persistedContinuity.bootstrapSignature);
  const brokerSessionKey = readString(persistedContinuity.brokerSessionKey);
  const brokerTurnId = readString(persistedContinuity.brokerTurnId);
  return {
    ...(bootstrapSignature === undefined ? {} : { bootstrapSignature }),
    ...(brokerSessionKey === undefined || brokerTurnId === undefined ? {} : { brokerSessionKey, brokerTurnId }),
  };
}

export function buildClaudeBootstrapSignature(
  request: Pick<ProviderRequest, 'cwd'> & { bypassPermissions?: boolean; permissionMode?: PermissionMode },
  ids: Pick<IdPort, 'sha256'>,
  options: {
    derivedSystemPrompt?: string;
    conversationRef?: string;
    resumeExisting?: boolean;
    projectsRoot: string;
    model?: string;
    effort?: ProviderRequest['effort'];
  },
): ClaudeBootstrapSignature {
  return {
    cwd: request.cwd,
    systemPromptHash: buildSystemPromptSignature(ids, options.derivedSystemPrompt),
    permissionMode: request.permissionMode ?? resolveClaudePermissionMode(request.bypassPermissions ?? false),
    bootstrapConfigHash: hashClaudeBootstrapConfiguration(options),
  };
}

export function buildClaudeProviderServerSpec(host: ClaudeBrokerHostPlan): ProviderServerSpec {
  return {
    provider: 'claude',
    command: host.command,
    args: [...host.args],
    cwd: host.cwd,
    env: { ...host.environment },
    leaseMode: 'shared',
    idlePolicy: 'host-stats',
    shutdownCapability: {
      method: 'broker/shutdown',
      timeoutMs: 3_000,
    },
  };
}

export function mapSessionEnsureParams(
  request: Pick<
    ProviderRequest,
    'action' | 'sessionId' | 'cwd' | 'bypassPermissions' | 'conversationRef' | 'coralEnv' | 'model' | 'effort'
  >,
  ids: Pick<IdPort, 'sha256'>,
  options: {
    derivedSystemPrompt?: string;
    controllerEnv: Readonly<Record<string, string>>;
    projectsRoot: string;
  },
): SessionEnsureParams {
  const conversationRef = claudeConversationRef(request);
  const resumeExisting = request.action === 'resume';
  const bootstrapSignature = buildClaudeBootstrapSignature(request, ids, {
    derivedSystemPrompt: options.derivedSystemPrompt,
    conversationRef,
    resumeExisting,
    projectsRoot: options.projectsRoot,
    model: request.model,
    effort: request.effort,
  });
  return {
    ...bootstrapSignature,
    brokerSessionKey: undefined,
    conversationRef,
    resumeExisting,
    controllerEnv: normalizeControllerEnv(options.controllerEnv),
    projectsRoot: options.projectsRoot,
    systemPrompt: options.derivedSystemPrompt,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
  };
}

export function claudeConversationRef(
  request: Pick<ProviderRequest, 'action' | 'sessionId' | 'conversationRef'>,
): string | undefined {
  return request.conversationRef ?? (request.action === 'exec' ? request.sessionId : undefined);
}

export function mapTurnStartParams(
  prompt: string,
  brokerSessionKey: string,
  ids: Pick<IdPort, 'uuid'>,
): TurnStartParams {
  return {
    brokerSessionKey,
    brokerTurnId: ids.uuid(),
    prompt,
  };
}

export function mapInterruptParams(brokerSessionKey: string, brokerTurnId: string): TurnInterruptParams {
  return { brokerSessionKey, brokerTurnId };
}

export function buildClaudeContinuity(update: {
  bootstrapSignature: ClaudeBootstrapSignature;
  brokerSessionKey?: string;
  brokerTurnId?: string;
}): ClaudePersistedContinuity {
  return {
    bootstrapSignature: update.bootstrapSignature,
    ...(update.brokerSessionKey === undefined || update.brokerTurnId === undefined
      ? {}
      : { brokerSessionKey: update.brokerSessionKey, brokerTurnId: update.brokerTurnId }),
  };
}

export function withClaudeContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  update: {
    bootstrapSignature?: ClaudeBootstrapSignature;
    brokerSessionKey?: string;
    brokerTurnId?: string;
  },
): ClaudePersistedContinuity {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  const bootstrapSignature = update.bootstrapSignature ?? continuity.bootstrapSignature;
  return {
    ...(bootstrapSignature === undefined ? {} : { bootstrapSignature }),
    ...(update.brokerSessionKey === undefined || update.brokerTurnId === undefined
      ? {}
      : { brokerSessionKey: update.brokerSessionKey, brokerTurnId: update.brokerTurnId }),
  };
}

export function resolveClaudeBrokerEntrypoint(storage: Pick<StoragePort, 'existsSync'>): string {
  if (typeof __PLUGIN_ROOT__ !== 'string') {
    throw new Error('Claude broker entrypoint requires __PLUGIN_ROOT__ to be defined at build time.');
  }

  const activeBundleDir = typeof __BUNDLE_DIR__ === 'string' && __BUNDLE_DIR__.length > 0 ? __BUNDLE_DIR__ : null;
  const activeBundlePath = activeBundleDir === null ? null : join(activeBundleDir, 'coral-claude-appserver.cjs');
  if (activeBundlePath !== null && storage.existsSync(activeBundlePath)) {
    return activeBundlePath;
  }

  const bundledPath = join(__PLUGIN_ROOT__, 'bridge', 'coral-claude-appserver.cjs');
  if (storage.existsSync(bundledPath)) {
    return bundledPath;
  }

  const compiledPath = join(__PLUGIN_ROOT__, 'dist', 'providers', 'claude', 'appserver', 'server.js');
  if (storage.existsSync(compiledPath)) {
    return compiledPath;
  }

  return bundledPath;
}

function buildSystemPromptSignature(ids: Pick<IdPort, 'sha256'>, derivedSystemPrompt?: string): string {
  if (typeof derivedSystemPrompt === 'string' && derivedSystemPrompt.startsWith('sha256:')) {
    return derivedSystemPrompt;
  }
  return `sha256:${ids.sha256(derivedSystemPrompt ?? '')}`;
}

export function buildClaudeEnvHash(
  controllerEnv: Record<string, string> | undefined,
  baseEnv: Readonly<Record<string, string>>,
): string {
  if (envHashCache && envHashCache.controllerEnv === controllerEnv && envHashCache.baseEnv === baseEnv) {
    return envHashCache.hash;
  }

  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string' && !key.startsWith('CORAL_')) {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(normalizeControllerEnv(controllerEnv))) {
    childEnv[key] = value;
  }
  childEnv.CORAL_CHILD = '1';
  const hash = hashSortedEnv(childEnv);
  envHashCache = { controllerEnv, baseEnv, hash };
  return hash;
}

function resolveClaudePermissionMode(bypassPermissions: boolean): PermissionMode {
  return bypassPermissions ? 'bypassPermissions' : 'default';
}
