const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');

const selectedBackend = process.env.CORAL_DELEGATION_SELECTED_BACKEND;
const expectedSocket = process.env.CORAL_DELEGATION_EXPECTED_SOCKET;
const gatePath = process.env.CORAL_DELEGATION_GATE;
const observationPath = process.env.CORAL_DELEGATION_OBSERVATION;
const mode = process.env.CORAL_DELEGATION_MODE;
const selectionSwitchBackend = process.env.CORAL_DELEGATION_SELECTION_SWITCH_BACKEND;
const nextSelectionPath = process.env.CORAL_DELEGATION_NEXT_SELECTION;
const selectionPath = process.env.CORAL_DELEGATION_SELECTION;
const ambientBackend = process.env.CORAL_DELEGATION_AMBIENT_BACKEND;
const ambientSelectionPath = process.env.CORAL_DELEGATION_AMBIENT_SELECTION;
const ambientInfoPath = process.env.CORAL_DELEGATION_AMBIENT_INFO;
const ambientPidPath = process.env.CORAL_DELEGATION_AMBIENT_PID;

if (
  selectionSwitchBackend &&
  nextSelectionPath &&
  selectionPath &&
  process.argv[1] === selectionSwitchBackend
) {
  fs.renameSync(nextSelectionPath, selectionPath);
}

if (
  selectedBackend &&
  ambientBackend &&
  ambientSelectionPath &&
  ambientInfoPath &&
  ambientPidPath &&
  selectionPath &&
  process.argv[1] === selectedBackend
) {
  fs.renameSync(ambientSelectionPath, selectionPath);
  const ambientEnvironment = { ...process.env };
  delete ambientEnvironment.NODE_OPTIONS;
  delete ambientEnvironment.CORAL_STARTUP_ATTEMPT_ID;
  delete ambientEnvironment.CORAL_STARTUP_STARTED_AT;
  const ambient = spawn(process.execPath, [ambientBackend], {
    detached: true,
    env: ambientEnvironment,
    stdio: 'ignore',
  });
  ambient.unref();
  if (ambient.pid === undefined) {
    throw new Error('Ambient coordinator did not receive a pid');
  }
  fs.writeFileSync(ambientPidPath, String(ambient.pid));

  const waitState = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(ambientInfoPath)) {
      const info = JSON.parse(fs.readFileSync(ambientInfoPath, 'utf8'));
      if (info.pid === ambient.pid) {
        ready = true;
        break;
      }
    }
    Atomics.wait(waitState, 0, 0, 10);
  }
  if (!ready) {
    throw new Error(`Ambient coordinator ${ambient.pid} did not publish ${ambientInfoPath}`);
  }
}

if (selectedBackend && expectedSocket && gatePath && observationPath && process.argv[1] === selectedBackend) {
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(address, ...args) {
    const requestedAddress = typeof address === 'string' ? address : address?.path;
    if (requestedAddress !== expectedSocket) {
      return originalListen.call(this, address, ...args);
    }

    fs.appendFileSync(
      observationPath,
      `${JSON.stringify({ event: 'entered', pid: process.pid, mode, requestedAddress })}\n`,
    );
    const waitState = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(gatePath)) {
      Atomics.wait(waitState, 0, 0, 10);
    }
    fs.appendFileSync(
      observationPath,
      `${JSON.stringify({ event: 'released', pid: process.pid, mode, requestedAddress })}\n`,
    );

    if (mode === 'ready') {
      return originalListen.call(this, address, ...args);
    }
    if (mode === 'refusal') {
      throw {
        code: 'handoff_socket_holder_unverified',
        userMessage: `Handoff refused at the startup deadline for socket ${expectedSocket}: the socket remained bound but no verified holder pid was available.`,
        remediation: 'Inspect and recover the process or stale socket that holds the coordinator socket, then retry handoff.',
        context: { stage: 'handoff-deadline', socketPath: expectedSocket },
      };
    }
    if (mode === 'crash') {
      process.exit(23);
    }
    if (mode === 'signal') {
      process.removeAllListeners('SIGTERM');
      process.kill(process.pid, 'SIGTERM');
      return this;
    }
    throw new Error(`Unsupported delegation fixture mode: ${String(mode)}`);
  };
}
