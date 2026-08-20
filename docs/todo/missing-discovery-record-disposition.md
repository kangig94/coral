# TODO — a missing discovery record is an absence to one command and an unknown to two others

**Status**: open. Half of it was closed on `fix/build-identity-per-boot` — `backend status` and
`backend shutdown` stopped calling a missing record an absence — and the same change made the disagreement
with `coral-cli expansion` visible, because until then all three were wrong the same way. What remains is one
decision about how much evidence this observation is worth taking.

## What exists

`observeCoordinator` (`src/transport/http/backend/coordinator-observation.ts`), which `backend status`
and `backend shutdown` share, now answers a missing record in two ways: `no-record` when the coordinator's
IPC socket path does not exist either, and `no-record-socket-present` when it does. The second is not an
absence — a coordinator binds its socket (`src/coordinator/lifecycle.ts`) before it writes its record,
so a record missing while the socket exists is a coordinator mid-boot as readily as a socket a
killed one left behind. Both commands exit 75 for it and say they could not tell.

`coral-cli expansion` reads the record on its own path and does not make that distinction
(`src/cli/expansion/index.ts`):

```ts
if (read.kind === 'missing') {
  return { status: 'unavailable' };
}
```

`unavailable` is documented one screen up (`src/cli/expansion/index.ts`) as an observed absence, and
renders as a catalog with nothing equipped. So during a coordinator's own boot window, `backend status` says
the state is unknown and `expansion list` says, positively, that nothing is equipped — from the same file
system, in the same second, on the same evidence.

## The part that is a decision, not a fix

Making `expansion` match `observeCoordinator` is mechanical. The question worth settling first is whether
`observeCoordinator` is taking enough evidence at all.

It decides on `runtime.storage.existsSync(socketPath)` alone. A socket file's existence separates "nothing
ever started" from "something did", and nothing more — which is why the answer is 75 rather than an absence.
But this repository already owns two probes that would turn most of these into an **observed** answer:

- `probeSocketReleased` (`src/transport/ipc/ensure.ts`) binds the path and closes it; a successful
  bind means nothing is listening.
- `clearStaleSocket` (`src/transport/ipc/server.ts`) dials the path; `ECONNREFUSED` or `ENOENT` means
  nothing is listening, and it then unlinks the file.

Either would separate a coordinator mid-boot (something answers) from a socket a SIGKILL left behind (nothing
does), which is the distinction both commands currently tell the operator they cannot make.

**The cost is what has to be weighed.** Both probes are asynchronous, and `observeCoordinator` is
synchronous — it is called from `shutdownBackend` and `getBackendStatusFull`, both already `async`, so the
change is reachable, but it moves a filesystem check into a network round trip on a path that runs before
every mutating CLI command. That is the same trade `containment-observation-deadline.md` is about one layer
down: an observation that costs a round trip has to fit inside whatever bounds the caller.

There is also a smaller, cheaper option that is not equivalent and should not be mistaken for one: `lstat`
the path and require it to be a socket rather than any file. That rules out a stray regular file at the path;
it says nothing about whether anything is listening.

## Why it was not done on the branch that found it

That branch's subject was giving one machine state one verdict across the backend commands. Extending the
same evidence to a third command is in scope for that sentence; making the evidence itself stronger is a
different change with a latency cost, and folding the two together would have made the second invisible
inside the first.

## Required shape

One reader for "is there a coordinator behind this record's absence", used by all three commands, whose
return type carries whichever of the three answers it actually established. Whether that reader dials is the
decision above. Whatever it answers, `expansion` renders the same disposition as `backend status` for the
same evidence, rather than a catalog.
