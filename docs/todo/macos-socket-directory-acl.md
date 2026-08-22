# TODO — macOS ACL access is outside the socket-directory check

**Status**: open, recorded during the PR gate for `fix/coordinator-socket-identity`, and not fixed on that
branch. The branch establishes a POSIX owner-and-mode property for relocated socket directories; it does
not establish effective access on a filesystem with an additional ACL policy.

## What the check proves

`ensurePrivateSocketDir` (`src/infra/private-socket-directory.ts`) observes the entry with non-following
`lstat`, requires the expected uid and directory file type, requires mode `0700`, and reads that mode back
after `chmod`. It separately requires a trusted parent owner and either no group/other write bits or the
restricted-deletion bit. Those are the owner, type, and BSD/POSIX mode facts exposed by Node's `fs.Stats`;
they are what the check proves.

## What it cannot prove

macOS ACLs can grant a named user or group rights beyond the BSD mode bits. Apple documents ACLs as a more
detailed access policy than BSD permissions in [File System Details](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html),
while Node's [`fs.Stats`](https://nodejs.org/api/fs.html#class-fsstats) surface exposes uid, gid, mode, and
file metadata but no ACL entries. A successful `lstat` showing this uid and mode `0700` therefore does not
show that another principal lacks effective access.

The reachable case is a relocated socket directory with an inherited or explicitly added allow ACL for
another principal. Its owner and mode still satisfy `classifyEntry`, so Coral accepts it. If that ACL grants
the relevant directory search, write, or deletion rights, that principal can reach or replace entries in
the namespace even though the observation Coral made still reads `0700`.

## Why this branch does not fix it

The module's injected storage boundary contains Node `fs` operations only, and none returns ACL state.
Adding a macOS subprocess or native ACL binding would create a new platform observation and failure
contract, including whether an unreadable ACL is `unverified`, whether an allow entry is `unsecurable`, and
how inherited entries are handled. Folding those decisions into the socket-identity repair would make its
current owner-and-mode guarantee look complete without supplying the missing observation.

## What a fix needs

A fix needs a macOS ACL-capable port backed by an OS API or a strictly parsed system tool, applied to both
the relocated directory and the parent premise. It must distinguish no allow ACL from an ACL it could not
read, verify the result after any attempted tightening, preserve the existing refusal dispositions, and
run a macOS fixture that creates a `0700` directory with an allow ACL and demonstrates another principal's
effective access. Until then, callers must treat the check as owner-and-mode verification, not proof of
effective privacy.

## Start condition

Choose the ACL observation boundary and refusal mapping first; Node's current `fs` port cannot implement or
test either one.
