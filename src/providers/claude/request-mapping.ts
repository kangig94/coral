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
  normalizeControllerEnv,
  readBootstrapSignature,
  type ClaudeBootstrapSignature,
  type PermissionMode,
} from './request-prep.js';
import { claudeTransportEnv, resolveClaudeTransportMode } from './transport-mode.js';

export interface ClaudePersistedContinuity extends ProviderContinuityBlob {
  brokerSessionKey?: string;
  bootstrapSignature?: ClaudeBootstrapSignature;
  envHash?: string;
  conversationRef?: string;
  brokerTurnId?: string;
}

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
  return {
    brokerSessionKey: readString(persistedContinuity.brokerSessionKey),
    bootstrapSignature,
    envHash: readString(persistedContinuity.envHash),
    conversationRef: readString(persistedContinuity.conversationRef),
    brokerTurnId: readString(persistedContinuity.brokerTurnId),
  };
}

export function buildClaudeBootstrapSignature(
  request: Pick<ProviderRequest, 'cwd'> & { bypassPermissions?: boolean; permissionMode?: PermissionMode },
  ids: Pick<IdPort, 'sha256'>,
  derivedSystemPrompt?: string,
): ClaudeBootstrapSignature {
  return {
    cwd: request.cwd,
    systemPromptHash: buildSystemPromptSignature(ids, derivedSystemPrompt),
    permissionMode: request.permissionMode ?? resolveClaudePermissionMode(request.bypassPermissions ?? false),
  };
}

export function buildClaudeProviderServerSpec(
  request: Pick<ProviderRequest, 'cwd'> & { coralEnv?: Record<string, string> },
  storage: Pick<StoragePort, 'existsSync'>,
): ProviderServerSpec {
  const transportMode = resolveClaudeTransportMode(request.coralEnv);
  return {
    provider: 'claude',
    command: process.execPath,
    args: [resolveClaudeBrokerEntrypoint(storage)],
    cwd: request.cwd,
    env: claudeTransportEnv(transportMode),
    shared: true,
    shutdownCapability: {
      method: 'broker/shutdown',
      timeoutMs: 3_000,
    },
  };
}

export function mapSessionEnsureParams(
  request: Pick<ProviderRequest, 'cwd' | 'bypassPermissions' | 'conversationRef' | 'coralEnv' | 'model' | 'effort'>,
  ids: Pick<IdPort, 'sha256'>,
  derivedSystemPrompt?: string,
  persistedContinuity?: ProviderContinuityBlob,
): SessionEnsureParams {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  const bootstrapSignature = buildClaudeBootstrapSignature(request, ids, derivedSystemPrompt);
  return {
    ...bootstrapSignature,
    brokerSessionKey: continuity.brokerSessionKey,
    conversationRef: continuity.conversationRef ?? request.conversationRef,
    controllerEnv: normalizeControllerEnv(request.coralEnv),
    systemPrompt: derivedSystemPrompt,
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
  };
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

export function mapInterruptParams(brokerSessionKey: string, brokerTurnId?: string): TurnInterruptParams {
  return brokerTurnId ? { brokerSessionKey, brokerTurnId } : { brokerSessionKey };
}

export function buildClaudeContinuity(update: {
  brokerSessionKey?: string;
  bootstrapSignature: ClaudeBootstrapSignature;
  envHash?: string;
  conversationRef?: string;
  brokerTurnId?: string;
}): ClaudePersistedContinuity {
  const brokerSessionKey = readString(update.brokerSessionKey);
  const envHash = readString(update.envHash);
  const conversationRef = readString(update.conversationRef);
  const brokerTurnId = readString(update.brokerTurnId);
  return {
    ...(brokerSessionKey !== undefined ? { brokerSessionKey } : {}),
    bootstrapSignature: update.bootstrapSignature,
    ...(envHash !== undefined ? { envHash } : {}),
    ...(conversationRef !== undefined ? { conversationRef } : {}),
    ...(brokerTurnId !== undefined ? { brokerTurnId } : {}),
  };
}

export function withClaudeContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  update: {
    brokerSessionKey?: string;
    bootstrapSignature?: ClaudeBootstrapSignature;
    envHash?: string;
    conversationRef?: string;
    brokerTurnId?: string;
  },
): ClaudePersistedContinuity {
  const continuity = readClaudePersistedContinuity(persistedContinuity);
  const brokerSessionKey = readString(update.brokerSessionKey) ?? continuity.brokerSessionKey;
  const bootstrapSignature = update.bootstrapSignature ?? continuity.bootstrapSignature;
  const envHash = readString(update.envHash) ?? continuity.envHash;
  const conversationRef = readString(update.conversationRef) ?? continuity.conversationRef;
  const brokerTurnId = readString(update.brokerTurnId) ?? continuity.brokerTurnId;
  return {
    ...(brokerSessionKey !== undefined ? { brokerSessionKey } : {}),
    ...(bootstrapSignature !== undefined ? { bootstrapSignature } : {}),
    ...(envHash !== undefined ? { envHash } : {}),
    ...(conversationRef !== undefined ? { conversationRef } : {}),
    ...(brokerTurnId !== undefined ? { brokerTurnId } : {}),
  };
}

function resolveClaudeBrokerEntrypoint(storage: Pick<StoragePort, 'existsSync'>): string {
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
