let ignoreDisconnect = false;
let holdAnswers = false;
let heldChallenge = null;
process.on('SIGTERM', () => {
  if (heldChallenge !== null) {
    holdAnswers = false;
    process.send?.({ kind: 'coral-sentinel-answer', id: heldChallenge });
    heldChallenge = null;
  }
});
process.on('message', (message) => {
  if (message?.kind === 'coral-sentinel-challenge') {
    if (holdAnswers) heldChallenge = message.id;
    else process.send?.({ kind: 'coral-sentinel-answer', id: message.id });
  } else if (message?.kind === 'pause-answers') {
    holdAnswers = true;
  } else if (message?.kind === 'freeze') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } else if (message?.kind === 'disconnect-and-freeze') {
    ignoreDisconnect = true;
    process.disconnect();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } else if (message?.kind === 'exit') {
    process.exit(0);
  }
});
process.on('disconnect', () => {
  if (!ignoreDisconnect) process.exit(0);
});
process.send?.({ kind: 'ready', pid: process.pid });
