const fs = require('node:fs');
const net = require('node:net');

const expectedSocket = process.env.CORAL_HANDOFF_FAULT_SOCKET;
const armMarker = process.env.CORAL_HANDOFF_FAULT_ARM_MARKER;
const observationPath = process.env.CORAL_HANDOFF_FAULT_OBSERVATION;
const secret = process.env.CORAL_HANDOFF_FAULT_SECRET;

if (expectedSocket && armMarker && observationPath && secret) {
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(address, ...args) {
    const requestedAddress = typeof address === 'string' ? address : address?.path;
    if (requestedAddress !== expectedSocket || !fs.existsSync(armMarker)) {
      return originalListen.call(this, address, ...args);
    }
    fs.appendFileSync(
      observationPath,
      `${JSON.stringify({ event: 'armed-bind-intercepted', pid: process.pid, requestedAddress })}\n`,
    );
    throw new Error(secret);
  };
}
