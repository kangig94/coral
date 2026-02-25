import { describe, it, expect } from 'vitest';
import {
  wrapText,
  generateOneLiner,
  renderEntries,
  renderEntry,
  renderHeader,
  formatAgentView,
  formatRecent,
  formatSummary,
} from '../transcript.js';
import type { AgentState, TranscriptEntry } from '../types.js';

const agents: Record<string, AgentState> = {
  alice: { persona: '', display_name: 'Alice', participation: 'required', quota_remaining: 3, total_speaks: 0, fallback_used: false, banned: false },
  bob: { persona: '', display_name: 'Bob', participation: 'required', quota_remaining: 3, total_speaks: 0, fallback_used: false, banned: false },
};

const TS = '2026-01-01T10:00:00Z';

function speechEntry(agent: string, content: string, step = 1): TranscriptEntry {
  const displayName = agent[0]!.toUpperCase() + agent.slice(1);
  return {
    type: 'speech',
    step,
    epoch: 1,
    ts: TS,
    agent,
    display_name: displayName,
    content,
  };
}


describe('wrapText', () => {
  it('should pass through short text unchanged', () => {
    expect(wrapText('Hello world.')).toBe('Hello world.');
  });

  it('should wrap at word boundary before 80 chars', () => {
    const word = 'abcdefghij'; // 10 chars
    const text = Array(9).fill(word).join(' '); // 98 chars with spaces
    const result = wrapText(text);
    const lines = result.split('\n');
    expect(lines.every((l) => l.length <= 100)).toBe(true);
  });

  it('should extend to sentence end in grace zone (80-100)', () => {
    const text = 'A'.repeat(75) + ' end sentence here. Next word here.';
    const result = wrapText(text);
    const firstLine = result.split('\n')[0];
    expect(firstLine.endsWith('here.') || firstLine.length <= 100).toBe(true);
  });

  it('should hard-wrap at 100 chars when no sentence end', () => {
    const text = Array(30).fill('word').join(' '); // well over 100
    const result = wrapText(text);
    for (const line of result.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(104); // allow single word overflow
    }
  });

  it('should preserve empty lines (paragraph breaks)', () => {
    const text = 'First paragraph.\n\nSecond paragraph.';
    expect(wrapText(text)).toContain('\n\n');
  });
});


describe('generateOneLiner', () => {
  it('should return full text if under 100 chars', () => {
    expect(generateOneLiner('Short text.')).toBe('Short text.');
  });

  it('should truncate at sentence boundary', () => {
    const text = 'First sentence ends here. Second sentence continues on.';
    expect(generateOneLiner(text)).toBe('First sentence ends here.');
  });

  it('should truncate at word boundary with ellipsis if no sentence', () => {
    const text = 'A'.repeat(50) + ' B'.repeat(30);
    const result = generateOneLiner(text);
    expect(result.length).toBeLessThanOrEqual(103); // 100 + '…'
    expect(result.endsWith('…')).toBe(true);
  });
});


describe('renderHeader', () => {
  it('should include topic and Epoch 1 header', () => {
    const result = renderHeader('My Discussion');
    expect(result).toContain('# My Discussion');
    expect(result).toContain('## Epoch 1');
  });
});


describe('renderEntries', () => {
  it('should return empty string for empty input', () => {
    expect(renderEntries([], agents)).toBe('');
  });

  it('should render speech entry with agent name and content', () => {
    const entries: TranscriptEntry[] = [speechEntry('alice', 'My argument.')];
    const result = renderEntries(entries, agents);
    expect(result).toContain('Alice');
    expect(result).toContain('My argument.');
  });

  it('should render bids entry with table and winner', () => {
    const entries: TranscriptEntry[] = [
      { type: 'bids', step: 1, epoch: 1, ts: TS, bids: { alice: 80, bob: 50 }, winner: 'alice', resolve_type: 'normal' },
    ];
    const result = renderEntries(entries, agents);
    expect(result).toContain('80');
    expect(result).toContain('Winner: Alice');
    expect(result).toContain('Quota');
  });

  it('should render bids entry with no_winner when winner is null', () => {
    const entries: TranscriptEntry[] = [
      { type: 'bids', step: 1, epoch: 1, ts: TS, bids: { alice: 5, bob: 3 }, winner: null, resolve_type: 'no_winner' },
    ];
    const result = renderEntries(entries, agents);
    expect(result).toContain('No winner');
  });

  it('should render epoch_summary entry', () => {
    const entries: TranscriptEntry[] = [
      { type: 'epoch_summary', epoch: 1, ts: TS, summary: 'Key insights from epoch 1.' },
    ];
    const result = renderEntries(entries, agents);
    expect(result).toContain('Epoch Summary');
    expect(result).toContain('Key insights from epoch 1.');
  });

  it('should render session_event synthesis', () => {
    const entries: TranscriptEntry[] = [
      { type: 'session_event', epoch: 1, ts: TS, event: 'synthesis', detail: 'Final conclusion here.' },
    ];
    const result = renderEntries(entries, agents);
    expect(result).toContain('Synthesis');
    expect(result).toContain('Final conclusion here.');
  });

  it('should render session_event force_end', () => {
    const entries: TranscriptEntry[] = [
      { type: 'session_event', epoch: 1, ts: TS, event: 'force_end', detail: 'Timed out.' },
    ];
    const result = renderEntries(entries, agents);
    expect(result).toContain('force_end');
    expect(result).toContain('Timed out.');
  });
});


describe('formatAgentView', () => {
  it('should show winner name from bids entry but not scores', () => {
    const entries: TranscriptEntry[] = [
      { type: 'bids', step: 1, epoch: 1, ts: TS, bids: { alice: 80, bob: 50 }, winner: 'alice', resolve_type: 'normal' },
      speechEntry('alice', 'My argument.'),
    ];
    const result = formatAgentView(entries, agents);
    expect(result).toContain('Speaker: Alice');  // winner revealed
    expect(result).not.toContain('80');           // bid score hidden
    expect(result).not.toContain('50');           // bid score hidden
    expect(result).toContain('My argument.');
  });

  it('should skip no_winner bids entries (information veil)', () => {
    const entries: TranscriptEntry[] = [
      { type: 'bids', step: 1, epoch: 1, ts: TS, bids: { alice: 5, bob: 3 }, winner: null, resolve_type: 'no_winner' },
    ];
    const result = formatAgentView(entries, agents);
    expect(result).not.toContain('Speaker');
    expect(result).not.toContain('5');  // score hidden
  });

  it('should render speech and epoch_summary entries unmodified', () => {
    const entries: TranscriptEntry[] = [
      speechEntry('bob', 'Bob speaks.'),
      { type: 'epoch_summary', epoch: 1, ts: TS, summary: 'Epoch conclusion.' },
    ];
    const result = formatAgentView(entries, agents);
    expect(result).toContain('Bob speaks.');
    expect(result).toContain('Epoch conclusion.');
  });
});


describe('formatRecent', () => {
  it('should show last N speeches in full and earlier as one-line summaries', () => {
    const entries: TranscriptEntry[] = [
      speechEntry('alice', 'Alice first speech.', 1),
      speechEntry('bob', 'Bob response.', 2),
      speechEntry('alice', 'Alice again.', 3),
    ];
    const result = formatRecent(entries, 2, agents);
    expect(result).toContain('Earlier speeches');
    expect(result).toContain('Alice first speech.'); // appears as summary
    expect(result).toContain('Bob response.'); // in recent section (full)
    expect(result).toContain('Alice again.'); // in recent section (full)
  });

  it('should show all in full when lastN >= speech count', () => {
    const entries: TranscriptEntry[] = [
      speechEntry('alice', 'Only speech.'),
    ];
    const result = formatRecent(entries, 5, agents);
    expect(result).toContain('Only speech.');
    expect(result).not.toContain('Earlier speeches');
  });

  it('should exclude non-speech entries (bids)', () => {
    const entries: TranscriptEntry[] = [
      speechEntry('alice', 'Old speech.'),
      { type: 'bids', step: 2, epoch: 1, ts: TS, bids: { alice: 80 }, winner: 'alice', resolve_type: 'normal' },
      speechEntry('alice', 'New speech.', 2),
    ];
    const result = formatRecent(entries, 1, agents);
    expect(result).not.toContain('Step 2');  // bids excluded
    expect(result).not.toContain('Bids');    // no bid table
    expect(result).toContain('New speech.'); // last speech in full
    expect(result).toContain('Old speech.'); // older speech in summary
    expect(result).toContain('Alice');       // speaker identity preserved
  });

  it('should show speaker display_name in both summary and recent sections', () => {
    const entries: TranscriptEntry[] = [
      speechEntry('alice', 'First.', 1),
      speechEntry('bob', 'Second.', 2),
    ];
    const result = formatRecent(entries, 1, agents);
    expect(result).toContain('- Alice:'); // older speech summary with name prefix
    expect(result).toContain('Bob');      // recent speech header with name
  });

  it('should return empty string for empty entries', () => {
    expect(formatRecent([], 5, agents)).toBe('');
  });
});


describe('renderEntry bids with effective_bids', () => {
  it('should show Raw and Effective columns when effective_bids is present', () => {
    const entry: TranscriptEntry = {
      type: 'bids', step: 1, epoch: 1, ts: TS,
      bids: { alice: 80, bob: 50 },
      effective_bids: { alice: 85.0, bob: 62.5 },
      winner: 'alice', resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result).toContain('Raw');
    expect(result).toContain('Effective');
    expect(result).toContain('85');
    expect(result).toContain('62.5');
    expect(result).not.toContain('| Agent | Score |');
  });

  it('should sort rows by effective score descending when effective_bids is present', () => {
    const entry: TranscriptEntry = {
      type: 'bids', step: 1, epoch: 1, ts: TS,
      bids: { alice: 80, bob: 50 },
      effective_bids: { alice: 60.0, bob: 90.0 },
      winner: 'alice', resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    const aliceIdx = result.indexOf('Alice');
    const bobIdx = result.indexOf('Bob');
    expect(bobIdx).toBeLessThan(aliceIdx); // bob row appears first
  });

  it('should show legacy single-column table when effective_bids is absent', () => {
    const entry: TranscriptEntry = {
      type: 'bids', step: 1, epoch: 1, ts: TS,
      bids: { alice: 80, bob: 50 },
      winner: 'alice', resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result).toContain('Score');
    expect(result).not.toContain('Raw');
    expect(result).not.toContain('Effective');
  });
});


describe('formatSummary', () => {
  it('should return one-liner for each speech entry', () => {
    const entries: TranscriptEntry[] = [
      speechEntry('alice', 'Alice made a point.'),
      speechEntry('bob', 'Bob disagreed.', 2),
    ];
    const result = formatSummary(entries, agents);
    expect(result).toContain('- Alice:');
    expect(result).toContain('- Bob:');
  });

  it('should omit non-speech entries', () => {
    const entries: TranscriptEntry[] = [
      { type: 'bids', step: 1, epoch: 1, ts: TS, bids: { alice: 80 }, winner: 'alice', resolve_type: 'normal' },
      speechEntry('alice', 'Only this.'),
    ];
    const result = formatSummary(entries, agents);
    expect(result).not.toContain('Bids');
    expect(result).toContain('- Alice:');
  });

  it('should return empty string for no speech entries', () => {
    expect(formatSummary([], agents)).toBe('');
  });
});


describe('renderEntry bids (adversarial)', () => {
  it('should show Raw and Effective columns when effective_bids are present', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 60, bob: 50 },
      effective_bids: { alice: 90, bob: 40 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result).toContain('| Agent | Raw | Effective | Quota |');
    expect(result).not.toContain('| Agent | Score | Quota |');
  });

  it('should show Score column when effective_bids are absent', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 60, bob: 50 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result).toContain('| Agent | Score | Quota |');
    expect(result).not.toContain('Raw');
    expect(result).not.toContain('Effective');
  });

  it('should sort two-column rows by effective score descending', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 60, bob: 80 },
      effective_bids: { alice: 90, bob: 70 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result.indexOf('| Alice (alice) | 60 | 90 | 3 |')).toBeLessThan(
      result.indexOf('| Bob (bob) | 80 | 70 | 3 |'),
    );
  });

  it('should render unknown agent rows with fallback display name and quota', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 70, carol: 50 },
      effective_bids: { alice: 70, carol: 55 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result).toContain('| Alice (alice) | 70 | 70 | 3 |');
    expect(result).toContain('| carol (carol) | 50 | 55 | ? |');
  });

  it('should keep large effective values inside table cells', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 10 },
      effective_bids: { alice: 9999 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result).toContain('| Agent | Raw | Effective | Quota |');
    expect(result).toContain('| Alice (alice) | 10 | 9999 | 3 |');
  });

  it('should render negative effective values clearly', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 10 },
      effective_bids: { alice: -100 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result).toContain('| Alice (alice) | 10 | -100 | 3 |');
  });
});


describe('formatAgentView (adversarial)', () => {
  it('should hide effective scores from agent-facing output', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 80, bob: 50 },
      effective_bids: { alice: 120, bob: 40 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = formatAgentView([entry], agents);
    expect(result).toContain('Speaker: Alice');
    expect(result).not.toContain('80');
    expect(result).not.toContain('50');
    expect(result).not.toContain('120');
    expect(result).not.toContain('40');
  });
});


// adversarial test (red-attacker provenance)
describe('formatAgentView edge cases', () => {
  it('produces the epoch header even for an empty transcript', () => {
    const result = formatAgentView([], agents);
    expect(result).toContain('## Epoch 1');
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('passes session_event entries through to output', () => {
    const entries = [
      {
        type: 'session_event' as const,
        epoch: 1,
        ts: TS,
        event: 'synthesis' as const,
        detail: 'Final synthesis conclusion here.',
      },
    ];
    const result = formatAgentView(entries, agents);
    expect(result).toContain('Final synthesis conclusion here.');
  });

  it('passes epoch_summary entries through to output', () => {
    const entries = [
      {
        type: 'epoch_summary' as const,
        epoch: 1,
        ts: TS,
        summary: 'The epoch had key moments.',
      },
    ];
    const result = formatAgentView(entries, agents);
    expect(result).toContain('The epoch had key moments.');
  });

  it('omits bid scores for no_winner bids entry', () => {
    const entries = [
      {
        type: 'bids' as const,
        step: 1,
        epoch: 1,
        ts: TS,
        bids: { alice: 75, bob: 60 },
        winner: null,
        resolve_type: 'no_winner' as const,
      },
    ];
    const result = formatAgentView(entries, agents);
    expect(result).not.toContain('75');
    expect(result).not.toContain('60');
    expect(result).not.toContain('Speaker');
  });

  it('renders winner display name (not agent key) for winning bids entry', () => {
    const entries = [
      {
        type: 'bids' as const,
        step: 1,
        epoch: 1,
        ts: TS,
        bids: { alice: 80, bob: 50 },
        winner: 'alice',
        resolve_type: 'normal' as const,
      },
    ];
    const result = formatAgentView(entries, agents);
    expect(result).toContain('Speaker: Alice');
    expect(result).not.toContain('Speaker: alice');
  });

  it('falls back to agent key as display name for an unknown winner', () => {
    const entries = [
      {
        type: 'bids' as const,
        step: 1,
        epoch: 1,
        ts: TS,
        bids: { zara: 80 },
        winner: 'zara',
        resolve_type: 'normal' as const,
      },
    ];
    const result = formatAgentView(entries, { ...agents });
    expect(result).toContain('zara');
  });
});


describe('renderEntries (adversarial)', () => {
  it('should mix legacy and effective bids renderings in order', () => {
    const legacy: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 60 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const decayed: TranscriptEntry = {
      type: 'bids',
      step: 2,
      epoch: 1,
      ts: TS,
      bids: { alice: 40 },
      effective_bids: { alice: 90 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntries([legacy, decayed], agents);
    const singleHeader = result.indexOf('| Agent | Score | Quota |');
    const effectiveHeader = result.indexOf('| Agent | Raw | Effective | Quota |');
    expect(singleHeader).toBeGreaterThan(-1);
    expect(effectiveHeader).toBeGreaterThan(-1);
    expect(singleHeader).toBeLessThan(effectiveHeader);
  });

  it('should place winner row first when effective sort is enabled', () => {
    const entry: TranscriptEntry = {
      type: 'bids',
      step: 1,
      epoch: 1,
      ts: TS,
      bids: { alice: 70, bob: 90 },
      effective_bids: { alice: 100, bob: 95 },
      winner: 'alice',
      resolve_type: 'normal',
    };
    const result = renderEntry(entry, agents);
    expect(result.indexOf('| Alice (alice) | 70 | 100 | 3 |')).toBeLessThan(
      result.indexOf('| Bob (bob) | 90 | 95 | 3 |'),
    );
    expect(result).toContain('> **Winner: Alice** (normal)');
  });
});
