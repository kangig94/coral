# TODO — own job scratch and hook state under shared temporary roots

**Status**: partly implemented. The private file modes and several other temporary paths are fixed; two directory ownership decisions remain.

`jobsDir` in `src/jobs/paths.ts` still returns `join(env.tmpdir(), 'coral-jobs')`. On a Linux host whose temp root is `/tmp`, that gives every user the same predictable parent. The durable wrapper's `env.json`, `stdout`, and `stderr` now use mode `0600`, but `initJob` and `appendLaunchRequested` in `src/jobs/store.ts` still create the job directory recursively without establishing who owns the shared parent. A foreign pre-created parent can deny access or control path resolution. Decide which installation or user identity should name the scratch root before setting its mode: recursive `mkdirSync` applies a supplied mode to components it creates, including the shared parent.

`sandboxTmpDir` in `clients/hooks/lib/plugin-paths.mjs` still defaults to `/tmp/claude-<uid>` without a Coral override. Hook writers create descendants there without checking the parent's owner or mode. Determine whether the harness owns that parent. Coral's hooks must fail open, so an unusable or foreign root should skip recording rather than stop a user command.

`ensurePrivateSocketDir` in `src/infra/private-socket-directory.ts` supplies an owner-and-mode check for the socket namespace; it does not choose the right identity for job scratch and cannot observe macOS ACL grants. Those decisions must precede reuse.

A repository-wide file privacy policy is still undecided: owner-specific `0600` constants and bare `0o600` literals coexist. Choose whether a shared file-creation primitive would enforce a real invariant before replacing those names mechanically.

## Start condition

For job scratch, choose a per-installation or per-user namespace and check consumers of the old literal path before renaming it. For hook state, establish the harness's ownership contract and add a fail-open disposition for a foreign parent.
