import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { discussRecordPath, renderDiscussRecordMarkdown, writeDiscussRecord } from '#src/discuss/transcript-export.js';
import type { PersistedDiscussSnapshot } from '#src/discuss/events.js';
import type { DiscussState, TranscriptEntry } from '#src/discuss/session-types.js';

function snapshot(over: Partial<DiscussState> = {}): PersistedDiscussSnapshot {
  const state = {
    topic: 'Should we adopt the new schema?',
    status: 'ended',
    created_at: '2026-06-10T09:15:30.000Z',
    epoch: 2,
    max_epochs: 2,
    quota_per_epoch: 3,
    agents: {
      a1: {
        persona: 'architect',
        display_name: 'Ada',
        participation: 'required',
        quota_remaining: 0,
        total_speaks: 1,
        fallback_used: false,
        banned: false,
      },
      a2: {
        persona: 'skeptic',
        display_name: 'Ben',
        participation: 'required',
        quota_remaining: 0,
        total_speaks: 1,
        fallback_used: false,
        banned: false,
      },
    },
    transcript: [] as TranscriptEntry[],
    ...over,
  } as unknown as DiscussState;
  return {
    schemaVersion: 2,
    sessionId: 'disc-123',
    projectRoot: '/work/proj',
    updatedAt: '2026-06-10T09:42:00.000Z',
    lastAppliedSeq: 9,
    state,
    runtime: {} as never,
  } as unknown as PersistedDiscussSnapshot;
}

const SPEECH_A: TranscriptEntry = {
  type: 'speech',
  agent: 'a1',
  display_name: 'Ada',
  content: 'I support it.',
  epoch: 1,
  step: 1,
} as unknown as TranscriptEntry;
const SPEECH_B: TranscriptEntry = {
  type: 'speech',
  agent: 'a2',
  display_name: 'Ben',
  content: 'I have concerns.',
  epoch: 1,
  step: 2,
} as unknown as TranscriptEntry;
const SUMMARY: TranscriptEntry = {
  type: 'epoch_summary',
  summary: 'Positions diverged.',
  epoch: 1,
} as unknown as TranscriptEntry;
const BIDS: TranscriptEntry = { type: 'bids', epoch: 1, resolve_type: 'normal' } as unknown as TranscriptEntry;
const SYNTHESIS: TranscriptEntry = {
  type: 'session_event',
  event: 'synthesis',
  detail: 'Adopt with a migration plan.',
  epoch: 2,
} as unknown as TranscriptEntry;

describe('renderDiscussRecordMarkdown', () => {
  it('renders header, participants, transcript speeches, and final synthesis', () => {
    const md = renderDiscussRecordMarkdown(snapshot({ transcript: [SPEECH_A, SPEECH_B, SUMMARY, SYNTHESIS] }));
    expect(md).toContain('# Discussion: Should we adopt the new schema?');
    expect(md).toContain('- Session: `disc-123`');
    expect(md).toContain('- Epochs: 2/2');
    expect(md).toContain('- Ada (architect)');
    expect(md).toContain('- Ben (skeptic)');
    expect(md).toContain('**Ada**');
    expect(md).toContain('I support it.');
    expect(md).toContain('**Ben**');
    expect(md).toContain('I have concerns.');
    expect(md).toContain('Epoch 1 summary:');
    expect(md).toContain('## Final Synthesis');
    expect(md).toContain('Adopt with a migration plan.');
  });

  it('omits bid audit entries from the human record', () => {
    const md = renderDiscussRecordMarkdown(snapshot({ transcript: [BIDS, SPEECH_A, SYNTHESIS] }));
    expect(md).not.toContain('bids');
    expect(md).not.toContain('resolve_type');
  });

  it('does not duplicate the synthesis inside the transcript section', () => {
    const md = renderDiscussRecordMarkdown(snapshot({ transcript: [SPEECH_A, SYNTHESIS] }));
    expect(md.split('Adopt with a migration plan.').length - 1).toBe(1);
  });

  it('renders placeholders when transcript or synthesis is empty', () => {
    const md = renderDiscussRecordMarkdown(snapshot({ transcript: [] }));
    expect(md).toContain('_(no transcript entries)_');
    expect(md).toContain('_(no synthesis recorded)_');
  });
});

describe('discussRecordPath', () => {
  it('builds <projectDataDir>/discuss/<YYYYMMDD-HHMMSS>-<topic-slug>.md', () => {
    const path = discussRecordPath('/data/projects/acme-repo', snapshot());
    expect(path).toBe(join('/data/projects/acme-repo', 'discuss', '20260610-091530-should-we-adopt-the-new-schema.md'));
  });

  it('falls back to a default slug when the topic has no slug-able characters', () => {
    const path = discussRecordPath('/d', snapshot({ topic: '???' }));
    expect(path).toBe(join('/d', 'discuss', '20260610-091530-discussion.md'));
  });
});

describe('writeDiscussRecord', () => {
  it('mkdirs the discuss dir and atomically writes the rendered record', () => {
    const mkdirSync = vi.fn();
    const writeAtomicSync = vi.fn((_path: string, _data: string, _opts?: unknown) => true);
    const projectData = (projectRoot: string) => join('/data/projects', projectRoot.replace(/\//g, '-'));

    const path = writeDiscussRecord(
      { storage: { mkdirSync, writeAtomicSync }, projectData },
      snapshot({ transcript: [SPEECH_A, SYNTHESIS] }),
    );

    const expectedDir = join('/data/projects', '-work-proj', 'discuss');
    expect(mkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(path).toBe(join(expectedDir, '20260610-091530-should-we-adopt-the-new-schema.md'));
    expect(writeAtomicSync).toHaveBeenCalledOnce();
    const [writtenPath, content] = writeAtomicSync.mock.calls[0];
    expect(writtenPath).toBe(path);
    expect(String(content)).toContain('## Final Synthesis');
  });

  it('throws when the atomic write fails', () => {
    const storage = { mkdirSync: vi.fn(), writeAtomicSync: vi.fn(() => false) };
    expect(() => writeDiscussRecord({ storage, projectData: (p) => p }, snapshot())).toThrow(
      /Failed to write discuss record/,
    );
  });
});
