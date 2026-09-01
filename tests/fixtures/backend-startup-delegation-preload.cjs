const fs = require('node:fs');
const net = require('node:net');

const selectedBackend = process.env.CORAL_DELEGATION_SELECTED_BACKEND;
const expectedSocket = process.env.CORAL_DELEGATION_EXPECTED_SOCKET;
const gatePath = process.env.CORAL_DELEGATION_GATE;
const observationPath = process.env.CORAL_DELEGATION_OBSERVATION;
const mode = process.env.CORAL_DELEGATION_MODE;
const directBundleHash = process.env.CORAL_DELEGATION_DIRECT_BUNDLE_HASH;
const selectedManifestPath = process.env.CORAL_DELEGATION_SELECTED_MANIFEST;

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
      const manifest = JSON.parse(fs.readFileSync(selectedManifestPath, 'utf8'));
      manifest.bundleHash = directBundleHash;
      fs.writeFileSync(selectedManifestPath, `${JSON.stringify(manifest)}\n`);
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
