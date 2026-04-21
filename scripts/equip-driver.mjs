#!/usr/bin/env node

function emit(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractStructuredError(error) {
  const direct = isRecord(error)
    && typeof error.code === 'string'
    && typeof error.userMessage === 'string'
    && typeof error.remediation === 'string'
    ? {
        code: error.code,
        userMessage: error.userMessage,
        remediation: error.remediation,
        context: isRecord(error.context) ? error.context : undefined,
      }
    : null;

  if (direct !== null) {
    return direct;
  }

  if (error instanceof Error) {
    return extractStructuredError(error.cause);
  }

  return null;
}

function errorJson(error, fallbackMessage) {
  const structured = extractStructuredError(error);
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
    message: fallbackMessage ?? (error instanceof Error ? error.message : String(error)),
  };
}

async function main() {
  const coralHome = process.env.CORAL_HOME;
  if (!coralHome) {
    emit({ status: 'error', message: 'CORAL_HOME is required' });
    return 1;
  }

  process.env.HOME = coralHome;
  process.env.USERPROFILE = coralHome;

  const argv = process.argv.slice(2);
  const hasExplicitAction = argv[0] === 'install' || argv[0] === 'uninstall';
  const action = hasExplicitAction ? argv[0] : 'install';
  const name = hasExplicitAction ? argv[1] : argv[0];

  if (!name) {
    emit({ status: 'error', message: 'Equipment name is required' });
    return 1;
  }

  const { runInstallCommand } = await import('../skills/equip/install.mjs');
  const installRun = await runInstallCommand(action === 'uninstall' ? ['uninstall', name] : [name]);

  if (action === 'uninstall' || installRun.exitCode !== 0) {
    emit(installRun.result);
    return installRun.exitCode;
  }

  if (!Array.isArray(installRun.result.postInstall) || !installRun.result.postInstall.includes('register_equipment')) {
    emit(installRun.result);
    return installRun.exitCode;
  }

  const { registerEquipment } = await import('../skills/equip/coordinator-client.mjs');

  try {
    const registered = await registerEquipment({ name });
    emit({
      ...registered,
      install: installRun.result,
    });
    return 0;
  } catch (error) {
    emit({
      ...errorJson(error, `Could not register ${name}`),
      install: installRun.result,
    });
    return 1;
  }
}

process.exitCode = await main();
