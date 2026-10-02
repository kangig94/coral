import { basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type ProjectSourceModule = typeof import('#src/infra/project-source.js');

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

async function loadProjectSourceModule(): Promise<ProjectSourceModule> {
  vi.resetModules();
  return import('#src/infra/project-source.js');
}

function remoteForProjectRoot(projectRoot: string): string {
  return `git@github.com:owner/${basename(projectRoot)}.git\n`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  execFileSyncMock.mockReset();
  vi.resetModules();
});

describe('resolveProjectSource', () => {
  // What may be remembered, by failure mode. The shapes are what `execFileSync` actually produces — verified
  // against Node, not assumed: a non-zero exit carries `status`, a missing binary carries `code: 'ENOENT'` with
  // `status: null`, and a timeout carries `code: 'ETIMEDOUT'` with `status: null`.
  const failure = (props: Record<string, unknown>): Error => Object.assign(new Error('probe failed'), props);

  // Only a launch that actually ran and exited is decisive here. `ENOENT`/`EACCES` moved out of this group:
  // a missing or unexecutable git binary is a standing fact about the *machine*, not a report about whether
  // *this project* has a remote (`process-constants.ts`'s `STANDING_PROBE_ERRNOS` docstring), so caching it as
  // "no remote" is the same durably-wrong-answer shape as caching a timeout would be. They now live in the
  // "re-probes rather than caching" group below, alongside every other non-answer.
  it('caches the local fallback after a non-zero exit — there is no remote, and re-asking cannot change that', async () => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: 128 });
    });

    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(execFileSyncMock, 'a decisive answer is asked once').toHaveBeenCalledOnce();
  });

  // `ETIMEDOUT`/`EAGAIN`/`ESTALE`/`EWOULDBLOCKX` are `no-answer` outright — the launch never produced a verdict.
  // `ENOENT`/`EACCES` are `launch-refused`: a *standing* fact about the machine (git will not appear under a
  // running daemon), but not a *decisive* one about this project's remote, which is the only question this
  // function asks (`process-constants.ts`'s `STANDING_PROBE_ERRNOS` docstring draws the distinction). Both
  // kinds reach the same indecisive-with-expiry path here, which is what this shared test proves — a caller
  // asking a domain question may not tell them apart, even though `classifyThrownExecOutcome` does. The
  // enumeration itself is on the standing side so that an errno nobody thought of is NOT cached as a fact; it
  // is not trying to be exhaustive and should not grow toward it — `EWOULDBLOCKX` is the case that matters,
  // because an errno this codebase has never heard of is the one a future revision will also not have heard of.
  it.each([['EWOULDBLOCKX — an errno this list has never heard of', 'EWOULDBLOCKX']])(
    're-probes rather than caching after %s',
    async (_label, code) => {
      const { resolveProjectSource } = await loadProjectSourceModule();
      execFileSyncMock.mockImplementationOnce(() => {
        throw failure({ status: null, code });
      });

      expect(resolveProjectSource('/tmp/busy'), 'the fallback is still answered').toBe('local/busy');

      vi.setSystemTime(Date.now() + 61_000);
      execFileSyncMock.mockImplementation(() => remoteForProjectRoot('/tmp/busy'));
      expect(resolveProjectSource('/tmp/busy'), 'and re-probed once the system can run it').toBe('owner/busy');
      expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    },
  );

  // The other half of that decision, and the reason it is an expiry rather than "never cache": this function is
  // called once per row inside `snapshotsForSource`, so re-probing on every call turns one stalled mount into
  // one blocking probe per row.
  it('does not re-probe a wedged root on every call within the interval', async () => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: null, code: 'ETIMEDOUT' });
    });

    for (let i = 0; i < 8; i += 1) {
      expect(resolveProjectSource('/tmp/wedged')).toBe('local/wedged');
    }

    expect(execFileSyncMock, 'eight rows on one wedged root cost one probe, not eight').toHaveBeenCalledOnce();
  });
});
