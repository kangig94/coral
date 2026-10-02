let holdAnswers = false;
let heldChallenge = null;

process.on('SIGTERM', () => {
  if (heldChallenge === null) return process.exit(0);
  process.send?.({ kind: 'coral-sentinel-answer', id: heldChallenge }, () => process.exit(0));
});

process.on('message', (message) => {
  if (message?.kind === 'coral-sentinel-challenge') {
    if (holdAnswers) heldChallenge = message.id;
    else process.send?.({ kind: 'coral-sentinel-answer', id: message.id });
  } else if (message?.kind === 'pause-answers') {
    holdAnswers = true;
  }
});

process.on('disconnect', () => process.exit(0));
process.send?.({ kind: 'ready', pid: process.pid });
