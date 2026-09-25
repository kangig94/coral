const { writeFileSync } = require('node:fs');
const { Server } = require('node:net');

const boundary = process.env.CORAL_TEST_SHIPPED_IPC_BOUNDARY;
const marker = process.env.CORAL_TEST_SHIPPED_IPC_MARKER;
const delayMs = Number(process.env.CORAL_TEST_SHIPPED_IPC_DELAY_MS);
let held = false;

if (marker && Number.isFinite(delayMs) && delayMs > 0) {
  if (boundary === 'starting') {
    const emit = Server.prototype.emit;
    Server.prototype.emit = function (event, ...args) {
      if (!held && event === 'listening' && typeof this.address() === 'string') {
        held = true;
        writeFileSync(marker, 'bound');
        setTimeout(() => emit.call(this, event, ...args), delayMs);
        return true;
      }
      return emit.call(this, event, ...args);
    };
  }

  if (boundary === 'draining') {
    const close = Server.prototype.close;
    Server.prototype.close = function (...args) {
      if (!held && typeof this.address() === 'string') {
        held = true;
        writeFileSync(marker, 'closing');
        setTimeout(() => close.apply(this, args), delayMs);
        return this;
      }
      return close.apply(this, args);
    };
  }
}
