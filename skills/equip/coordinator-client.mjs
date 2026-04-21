#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

const DEFAULT_IPC_TIMEOUT_MS = 5_000;
let nextRequestId = 1;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emit(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function coralBaseDir(baseDir) {
  return baseDir ?? join(homedir(), '.coral');
}

function resolvePluginRoot() {
  if (typeof process.env.CLAUDE_PLUGIN_ROOT === 'string' && process.env.CLAUDE_PLUGIN_ROOT.length > 0) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return process.cwd();
}

function readBuildFlavor(pluginRoot = resolvePluginRoot()) {
  try {
    const raw = readFileSync(join(pluginRoot, 'bridge', 'manifest.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && parsed.flavor === 'dev' ? 'dev' : 'prod';
  } catch {
    return 'prod';
  }
}

function coordinatorDiscoveryPath(flavor, options = {}) {
  return join(coralBaseDir(options.baseDir), flavor === 'dev' ? 'run-dev' : 'run', 'coordinator.json');
}

function readCoordinatorDiscovery(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return isRecord(parsed) && typeof parsed.socketPath === 'string' && parsed.socketPath.length > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function structuredCoordinatorError({ code, userMessage, remediation, context, cause }) {
  const error = new Error(userMessage, cause === undefined ? undefined : { cause });
  error.name = 'CoordinatorClientError';
  error.code = code;
  error.userMessage = userMessage;
  error.remediation = remediation;
  if (context !== undefined) {
    error.context = context;
  }
  return error;
}

function extractStructuredError(error) {
  if (!isRecord(error)) {
    return null;
  }

  if (
    typeof error.code === 'string' &&
    typeof error.userMessage === 'string' &&
    typeof error.remediation === 'string'
  ) {
    return {
      code: error.code,
      userMessage: error.userMessage,
      remediation: error.remediation,
      context: isRecord(error.context) ? error.context : undefined,
    };
  }

  return null;
}

function errorToJson(error) {
  const structured = extractStructuredError(error) ?? extractStructuredError(error instanceof Error ? error.cause : null);
  if (structured !== null) {
    return {
      status: 'error',
      code: structured.code,
      userMessage: structured.userMessage,
      remediation: structured.remediation,
      ...(structured.context === undefined ? {} : { context: structured.context }),
    };
  }

  return {
    status: 'error',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function isCoordinatorUnavailableError(error) {
  return error instanceof Error && error.code === 'ipc_connect_failed';
}

export function resolveCoordinatorSocketPath(options = {}) {
  if (typeof options.socketPath === 'string' && options.socketPath.length > 0) {
    return options.socketPath;
  }

  const preferredFlavor = options.flavor ?? readBuildFlavor(options.pluginRoot);
  const flavors = preferredFlavor === 'dev' ? ['dev', 'prod'] : ['prod', 'dev'];

  for (const flavor of flavors) {
    const discovery = readCoordinatorDiscovery(coordinatorDiscoveryPath(flavor, options));
    if (discovery !== null) {
      return discovery.socketPath;
    }
  }

  throw structuredCoordinatorError({
    code: 'ipc_connect_failed',
    userMessage: 'Coral coordinator IPC discovery is unavailable.',
    remediation: 'Start the coordinator and retry the equipment command.',
    context: {
      baseDir: coralBaseDir(options.baseDir),
      preferredFlavor,
    },
  });
}

function ipcConnectError(socketPath, error) {
  return structuredCoordinatorError({
    code: 'ipc_connect_failed',
    userMessage: `Failed to connect to the Coral coordinator at ${socketPath}.`,
    remediation:
      'Check whether the coordinator is still starting, or remove a stale socket/discovery record and retry.',
    context: {
      socketPath,
      cause: error instanceof Error ? error.message : String(error),
    },
    cause: error,
  });
}

export async function requestCoordinator(method, params, options = {}) {
  const socketPath = resolveCoordinatorSocketPath(options);
  const requestId = nextRequestId++;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IPC_TIMEOUT_MS;

  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = '';
    let timer = null;

    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      handler();
    };

    const onConnect = () => {
      socket.write(
        `${JSON.stringify({
          kind: 'request',
          id: requestId,
          method,
          ...(params === undefined ? {} : { params }),
        })}\n`,
      );
    };

    const onError = (error) => {
      finish(() => reject(ipcConnectError(socketPath, error)));
    };

    const onClose = () => {
      finish(() => reject(ipcConnectError(socketPath, new Error(`IPC connection closed before ${method} completed.`))));
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf-8');
      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const frame = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (frame.length === 0) {
          continue;
        }

        let envelope;
        try {
          envelope = JSON.parse(frame);
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
          return;
        }

        if (!isRecord(envelope)) {
          continue;
        }

        if (envelope.kind === 'response' && envelope.id === requestId) {
          finish(() => resolve(envelope.result));
          socket.destroy();
          return;
        }

        if (envelope.kind === 'error' && envelope.id === requestId && isRecord(envelope.error)) {
          const data = envelope.error.data;
          const structured = extractStructuredError(data);
          const message = typeof envelope.error.message === 'string'
            ? envelope.error.message
            : `Coordinator request failed for ${method}.`;
          const requestError = structured === null
            ? new Error(message, data === undefined ? undefined : { cause: data })
            : structuredCoordinatorError({
                code: structured.code,
                userMessage: structured.userMessage,
                remediation: structured.remediation,
                context: structured.context,
                cause: data,
              });
          finish(() => reject(requestError));
          socket.destroy();
          return;
        }
      }
    };

    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        socket.destroy(new Error(`IPC request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

export async function registerEquipment(request, options = {}) {
  return await requestCoordinator('coordinator.registerEquipment', request, options);
}

export async function unregisterEquipment(request, options = {}) {
  return await requestCoordinator('coordinator.unregisterEquipment', request, options);
}

export async function listEquipment(request = {}, options = {}) {
  return await requestCoordinator('coordinator.listEquipment', request, options);
}

export async function tryListEquipment(request = {}, options = {}) {
  try {
    return await listEquipment(request, options);
  } catch (error) {
    if (isCoordinatorUnavailableError(error)) {
      return null;
    }
    throw error;
  }
}

async function main() {
  const [command, name] = process.argv.slice(2);

  try {
    switch (command) {
      case 'register':
        if (!name) {
          emit({ status: 'error', message: 'Equipment name required for register' });
          return 1;
        }
        emit(await registerEquipment({ name }));
        return 0;
      case 'unregister':
        if (!name) {
          emit({ status: 'error', message: 'Equipment name required for unregister' });
          return 1;
        }
        emit(await unregisterEquipment({ name }));
        return 0;
      case 'list':
        emit(await listEquipment({}));
        return 0;
      default:
        emit({
          status: 'error',
          message: 'Usage: node coordinator-client.mjs <register|unregister|list> [name]',
        });
        return 1;
    }
  } catch (error) {
    emit(errorToJson(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
