import { describe, expect, it, vi } from 'vitest';
import { activePinCount, acquireProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
import { createEntry } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

describe('provider host lease properties', () => {
  it('treats double release of the same pin as a no-op', () => {
    const entry = createEntry();
    const onLastRelease = vi.fn();
    const release = acquireProviderHostPin(entry, { kind: 'acquisition', jobId: 'job-a' }, onLastRelease);

    expect(activePinCount(entry)).toBe(1);
    release();
    expect(activePinCount(entry)).toBe(0);
    expect(onLastRelease).toHaveBeenCalledOnce();

    expect(() => release()).not.toThrow();
    expect(activePinCount(entry)).toBe(0);
    expect(onLastRelease).toHaveBeenCalledOnce();
  });

  it.each([
    { firstIndex: 0, secondIndex: 1, survivor: { kind: 'attached-session' } },
    { firstIndex: 1, secondIndex: 0, survivor: { kind: 'acquisition', jobId: 'job-a' } },
  ] as const)(
    'releases two pins independently in order $firstIndex then $secondIndex',
    ({ firstIndex, secondIndex, survivor }) => {
      const entry = createEntry();
      const releaseAcquisition = acquireProviderHostPin(entry, { kind: 'acquisition', jobId: 'job-a' }, () => {});
      const releaseAttachedSession = acquireProviderHostPin(entry, { kind: 'attached-session' }, () => {});
      const releases = [releaseAcquisition, releaseAttachedSession] as const;

      releases[firstIndex]();
      expect(activePinCount(entry)).toBe(1);
      expect([...entry.pins.values()]).toStrictEqual([survivor]);

      releases[secondIndex]();
      expect(activePinCount(entry)).toBe(0);
    },
  );

  it('calls onLastRelease exactly once when the final pin is released', () => {
    const entry = createEntry();
    const onLastRelease = vi.fn();
    const releaseAcquisition = acquireProviderHostPin(entry, { kind: 'acquisition' }, onLastRelease);
    const releaseAttachedSession = acquireProviderHostPin(entry, { kind: 'attached-session' }, onLastRelease);

    releaseAcquisition();
    expect(activePinCount(entry)).toBe(1);
    expect(onLastRelease).not.toHaveBeenCalled();

    releaseAttachedSession();
    expect(activePinCount(entry)).toBe(0);
    expect(onLastRelease).toHaveBeenCalledOnce();

    releaseAcquisition();
    releaseAttachedSession();
    expect(onLastRelease).toHaveBeenCalledOnce();
  });
});
