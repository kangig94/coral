# Local app-server streams have no inactivity bound

The local app-server path can hold a launch permit indefinitely when a provider turn stops producing events
without closing its stream. `src/providers/app-server-transport.ts` bounds initialization, but the consuming
stream has no inactivity deadline. The durable-CLI path independently has `IDLE_TIMEOUT` in
`src/coordinator/live/durable-transport.ts`.

This is the likely cause of the usage-limit incident that prompted the launch-permit work: if the provider
stalls rather than returning a terminal or suspended event, the local `for await` never finishes and its
cleanup scope never runs. Exact permits make the hold visible and give a named holder an operator-abort exit;
they do not add an inactivity bound and therefore do not close this defect.

## Start condition

Reproduce or instrument a local app-server turn that remains open after provider inactivity, then define a
provider-safe inactivity disposition. Do not reuse the durable-CLI timeout without first deciding how an
app-server stream distinguishes a slow live turn from an abandoned one.
