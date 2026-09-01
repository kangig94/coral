import { writeFileSync } from 'node:fs';

const REPOSITORY_ARENA_COMPONENT_PATHS = {
  coral: 'coral',
  staging: 'coral/staging',
  'project-ignore': 'coral/staging/project-ignore',
};

const PROJECT_IGNORE_OUTCOME_NOTICES = {
  killed:
    'ran out of its time budget and was terminated; retry in a new session, and if it recurs, report it with this diagnostic',
  'not-spawned': 'could not be started',
  'no-output':
    'exited without reporting a result; retry in a new session, and if it recurs, report it with this diagnostic',
  'unparseable-output':
    'reported a result Coral could not read; retry in a new session, and if it recurs, report it with this diagnostic',
  'maintenance-busy':
    'did not start because another Coral project-ignore maintainer owns the lock; wait for that invocation to finish or terminate it if it is stuck',
  'maintenance-lock-unavailable':
    'could not open or own its maintenance lock; install flock and ensure ~/.coral/staging is a writable real directory with no symlink components',
  failed: 'ran and reported it could not complete safely',
  partial: 'made progress or retained Coral-owned staging but could not establish every required disposition',
};

export const PROJECT_IGNORE_REASON_NOTICES = {
  'project-context-unresolvable': {
    sentence:
      'Coral could not resolve the project and its Git context. Remedy: verify the project path is accessible and fix any error reported by `git status` in that directory.',
    retryable: true,
  },
  'project-path-unrepresentable': {
    sentence:
      'The project-relative path contains a carriage return or line feed, which .git/info/exclude cannot represent as one pattern. Remedy: rename the affected project directory to remove CR and LF characters.',
    retryable: false,
  },
  'exclude-path-unresolvable': {
    sentence:
      'Git did not return a usable .git/info/exclude path. Remedy: run `git rev-parse --git-path info/exclude` in the project and repair its Git metadata until that command succeeds.',
    retryable: false,
  },
  'artifact-unreadable': {
    sentence:
      'An affected ignore file is not a readable regular file, the existing .git/info path is a symlink or not a directory, or its real directory lacks owner access. Remedy: make the project .gitignore files and .git/info/exclude readable regular files, replace a symlink or non-directory .git/info with a real directory, and give an existing .git/info directory owner read, write, and execute access. This also applies if a prior Coral run was interrupted after creating that directory.',
    retryable: false,
  },
  'artifact-too-large': {
    sentence:
      "An affected ignore file exceeds Coral's 1 MiB safety limit. Remedy: reduce that file below 1 MiB before maintenance runs again.",
    retryable: false,
  },
  'artifact-changed': {
    sentence:
      'An ignore file changed while Coral was preparing its update. Remedy: let the other writer finish before Coral tries again.',
    retryable: true,
  },
  'artifact-observation-failed': {
    sentence:
      'Coral could not inspect or re-read an affected ignore file. Remedy: make the file and its parent directories observable by the current user, or repair the filesystem error blocking inspection.',
    retryable: true,
  },
  'claude-directory-missing': {
    sentence:
      'The project has no .claude directory, so Coral did not create the requested symlink. Remedy: run `mkdir .claude` in the project.',
    retryable: false,
  },
  'claude-directory-invalid': {
    sentence:
      'The project .claude path is not a real directory. Remedy: replace that file or symlink with a real directory before requesting the Coral symlink.',
    retryable: false,
  },
  'repository-arena-unavailable': {
    sentence:
      'Coral could not prepare its staging arena in the authorized common Git directory because an observation or filesystem operation failed. Remedy: make the common Git directory observable and writable and repair the reported filesystem failure.',
    retryable: true,
  },
  'repository-arena-conflict': {
    sentence: (artifact) => {
      const path = REPOSITORY_ARENA_COMPONENT_PATHS[artifact.component];
      return `The repository staging component ${path} is a symlink or non-directory. Remedy: run \`git rev-parse --git-common-dir\` in the project, then replace the ${path} component beneath the directory it prints with a real directory before Coral maintenance runs again.`;
    },
    retryable: false,
  },
  'staging-device-mismatch': {
    sentence:
      'The target and its authorized staging arena are on different devices, so Coral cannot safely replace an existing artifact. Remedy: place them on the same filesystem or update the affected ignore file or .claude/coral symlink manually.',
    retryable: false,
  },
  'publish-cross-device': {
    sentence:
      'The filesystem rejected an atomic replacement across devices. Remedy: place the target and its authorized staging arena on the same filesystem or update the affected ignore file or .claude/coral symlink manually.',
    retryable: false,
  },
  'publish-failed': {
    sentence:
      'The filesystem refused an artifact update. Remedy: check permissions and free space for the affected Coral state, project, and Git metadata paths.',
    retryable: true,
  },
  'symlink-target-unavailable': {
    sentence:
      'The Coral symlink target has a structural conflict. Remedy: replace the symlink or non-directory component at the selected ~/.coral/projects or ~/.coral/projects-dev root, or at its project leaf, with a directory owned and writable by the current user.',
    retryable: false,
  },
  'symlink-observation-failed': {
    sentence:
      'Coral could not inspect the project .claude/coral path. Remedy: make .claude and .claude/coral observable by the current user, including owner search access on .claude, and repair any filesystem error blocking inspection.',
    retryable: true,
  },
  'durability-evidence-unavailable': {
    sentence:
      'Coral could not record pending durability outside the working tree. Remedy: make the authorized project-ignore staging arena a writable real directory on a filesystem that supports directory fsync, then retry the maintenance.',
    retryable: true,
  },
  'durability-evidence-unreadable': {
    sentence:
      'Coral could not inspect pending durability evidence. Remedy: make the authorized project-ignore staging arena and its markers readable and owned by the current user, or repair the filesystem or storage device reporting the failure.',
    retryable: true,
  },
  'durability-evidence-quarantined': {
    sentence:
      'Coral moved a pending durability record it could not use into the project-ignore quarantine. Coral will preserve it there for inspection and will not retry that record or act on any target it might contain.',
    retryable: false,
  },
  'durability-evidence-cleanup-failed': {
    sentence:
      'Coral could not dispose of a pending durability record. Remedy: make the authorized project-ignore staging arena writable and repair any filesystem error blocking its removal or quarantine, then retry the maintenance.',
    retryable: true,
  },
  'durability-sync-unsupported': {
    sentence:
      'The platform does not support syncing an affected parent directory, so Coral retained the publication marker for reconciliation.',
    retryable: true,
  },
  'durability-sync-unsupported-discharged': {
    sentence:
      'The platform does not support syncing the parent named by a pending durability record, so Coral discharged that record and will not retry it.',
    retryable: false,
  },
  'durability-sync-failed': {
    sentence:
      'Coral could not sync the parent named by a retained durability record. Remedy: check the filesystem and storage device; the next run will reconcile that record before planning project artifacts.',
    retryable: true,
  },
  'staging-cleanup-failed': {
    sentence:
      'Coral published the artifact but could not remove its owned staging file. Remedy: make the authorized project-ignore staging arena writable.',
    retryable: true,
  },
  'symlink-conflict': {
    sentence:
      'The project .claude/coral path conflicts with the requested symlink. Remedy: move the conflicting entry aside or replace it with the intended Coral symlink.',
    retryable: false,
  },
  'legacy-sweep-failed': {
    sentence: (artifact) =>
      `Coral could not remove the authorized legacy staging path ${JSON.stringify(artifact.path)}. Remedy: remove that path manually or make its parent directory writable.`,
    retryable: true,
  },
  'legacy-sweep-observation-failed': {
    sentence: (artifact) =>
      `Coral could not inspect the legacy staging path ${JSON.stringify(artifact.path)}. Remedy: make that path and its parent directories observable by the current user, or repair the filesystem error blocking inspection.`,
    retryable: true,
  },
  'arena-sweep-failed': {
    sentence:
      "Coral could not inspect or clean one of its staging arenas. Remedy: ensure ~/.coral/staging/project-ignore and the common Git directory's coral/staging/project-ignore path are writable real directories.",
    retryable: true,
  },
  'arena-structural-conflict': {
    sentence:
      'A Coral staging arena component is a symlink or non-directory. Remedy: replace the conflicting component under ~/.coral/staging/project-ignore with a real directory, or run `git rev-parse --git-common-dir` in the project and repair the coral/staging/project-ignore component beneath the directory it prints.',
    retryable: false,
  },
  'upstream-refusal': {
    sentence:
      'An artifact was skipped because another artifact did not complete cleanly. Remedy: resolve the other refusal reported for this run.',
    retryable: false,
  },
};

export function projectIgnoreOutcomeNotice(outcome) {
  return PROJECT_IGNORE_OUTCOME_NOTICES[outcome] ?? null;
}

export function renderProjectIgnoreResultNotices(result) {
  const reasons = new Map();
  for (const artifact of Object.values(result?.artifacts ?? {})) {
    if (artifact.state === 'refused') {
      if (Array.isArray(artifact.reasons)) {
        for (const reason of artifact.reasons) {
          if (!reasons.has(reason)) reasons.set(reason, artifact);
        }
      } else {
        if (!reasons.has(artifact.reason)) reasons.set(artifact.reason, artifact);
      }
    } else if (artifact.reason === 'staging-cleanup-failed') {
      if (!reasons.has(artifact.reason)) reasons.set(artifact.reason, artifact);
    }
    for (const reason of artifact.durability?.reasons ?? []) {
      if (!reasons.has(reason)) reasons.set(reason, artifact);
    }
  }

  return [...reasons]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, artifact]) => {
      const notice = PROJECT_IGNORE_REASON_NOTICES[reason];
      const sentence =
        typeof notice.sentence === 'function' ? notice.sentence(artifact) : notice.sentence;
      return notice.retryable
        ? `${sentence} It is attempted again at the next session start.`
        : sentence;
    });
}

export function emitProjectIgnoreResult(result) {
  const notices = renderProjectIgnoreResultNotices(result);
  if (notices.length > 0) writeFileSync(2, `${notices.join('\n')}\n`);
  writeFileSync(1, `${JSON.stringify(result)}\n`);
}
