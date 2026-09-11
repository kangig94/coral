# Operator Command Rendering

Within `src/cli/format/backend.ts` and `src/recovery/provider-operation-remedy.ts`, a `coral-cli` literal may
appear only inside the designated typed command renderer. The recovery coordinator retry paths in
`src/cli/commands/backend.ts` must call those renderers and may not construct command literals. Operator-facing
prose must either be followed by an unchanged labeled command line (`command=`, `clear=`, `discard=`, or
`action=`) or name no command.

The invariant is scoped to those two complete backend-remedy renderer modules and the named recovery coordinator
functions it protects. Legacy command output elsewhere, including metavariable templates, remains out of scope.
