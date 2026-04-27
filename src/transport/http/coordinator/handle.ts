declare const __PLUGIN_ROOT__: string;

import { readCoordinatorInfo } from '../../../infra/coordinator-discovery.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { CoordinatorUnreachableError } from '../../../infra/http-errors.js';
import { isProcessAlive } from '../../../infra/node-process.js';
import { createRealRuntime } from '../../../runtime/real.js';

export type CoordinatorHandle = {
  port: number;
  host: string;
  token: string;
  instanceId: string;
  socketPath?: string;
};

function resolvePluginRoot(pluginRoot?: string): string {
  if (pluginRoot) {
    return pluginRoot;
  }
  if (typeof __PLUGIN_ROOT__ === 'string') {
    return __PLUGIN_ROOT__;
  }
  if (typeof __dirname === 'string') {
    return __dirname;
  }
  return process.cwd();
}

export async function withAbortTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveDiscoveredCoordinator(pluginRoot?: string): Promise<CoordinatorHandle> {
  const root = resolvePluginRoot(pluginRoot);
  const runtime = createRealRuntime(readBuildFlavor(root));
  const info = readCoordinatorInfo({
    storage: runtime.storage,
    env: runtime.env,
    paths: runtime.paths,
  });
  if (!info || !isProcessAlive(info.pid)) {
    throw new CoordinatorUnreachableError('Coral coordinator is not running.');
  }

  return {
    port: info.port,
    host: info.host,
    token: info.token,
    instanceId: info.instanceId,
    ...(info.host === '127.0.0.1' || info.host === '::1' || info.host === 'localhost'
      ? { socketPath: info.socketPath }
      : {}),
  };
}
