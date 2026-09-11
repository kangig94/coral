# Operator Command Rendering

Within `src/cli/format/backend.ts` and `src/cli/format/jobs.ts`, a `coral-cli` literal may appear only inside a
designated typed command renderer. The provider-operation remedy type module, durable transport, and the running,
startup, and settled-unbound recovery modules are fully command-literal-free. The named branch-owned recovery
quarantine helpers in `src/cli/commands/backend.ts` must call the CLI formatters and may not construct command
literals. Operator-facing prose must either be followed by an unchanged labeled command line (`command=`,
`clear=`, `discard=`, or `action=`) or name no command.

The invariant fully scans those two CLI formatter modules and the command-free recovery/runtime modules named
above. Because `src/cli/commands/backend.ts` contains grandfathered command prose, it scans only the named
recovery-quarantine parse, coordinator-call, error-rendering, and error-construction helpers. Legacy command output
elsewhere, including metavariable templates, remains out of scope.
