/* eslint-disable no-console */
import { encodeInstallError } from '../../expansion/errors.js';
import { installExpansion } from '../../expansion/install.js';

type InvocationOptions = {
  readonly lockTimeoutMs?: number;
  readonly update?: boolean;
};

function usageError(): Error {
  return new Error('usage: install-invocation <name> [--update] [--lock-timeout-ms=<ms>]');
}

function parseDiagnosticArgs(args: readonly string[]): InvocationOptions {
  const update = args.includes('--update');
  let lockTimeoutMs: number | undefined;

  for (const arg of args) {
    if (arg === '--update') {
      continue;
    }

    if (arg.startsWith('--lock-timeout-ms=')) {
      const rawValue = arg.slice('--lock-timeout-ms='.length);
      const value = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(value) || value < 0) {
        throw usageError();
      }
      lockTimeoutMs = value;
      continue;
    }

    throw usageError();
  }

  return {
    ...(update ? { update: true } : {}),
    ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
  };
}

function rebindHomeFromCoralHome(): void {
  const coralHome = process.env.CORAL_HOME;
  if (!coralHome) {
    return;
  }

  process.env.HOME = coralHome;
  process.env.USERPROFILE = coralHome;
  process.env.TMPDIR = coralHome;
}

async function emitJsonLine(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const [,, name, ...diagnosticArgs] = process.argv;
  if (!name) {
    await emitJsonLine(encodeInstallError(usageError()));
    process.exitCode = 2;
    return;
  }

  let options: InvocationOptions;
  try {
    options = parseDiagnosticArgs(diagnosticArgs);
  } catch (error) {
    await emitJsonLine(encodeInstallError(error));
    process.exitCode = 2;
    return;
  }

  rebindHomeFromCoralHome();

  try {
    const result = await installExpansion(name, options);
    await emitJsonLine(result);
    process.exitCode = result.status === 'error' ? 1 : 0;
  } catch (err) {
    await emitJsonLine(encodeInstallError(err));
    process.exitCode = 1;
  }
}

const keepAlive = setInterval(() => {}, 1_000);
void main()
  .catch(async (error) => {
    await emitJsonLine(encodeInstallError(error));
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keepAlive);
  });
