import { describe, expect, it } from 'vitest';

import { buildBidPrompt, buildFirstTurnInstruction, buildSpeechPrompt } from '#src/discuss/shell/prompts.js';
import type { PromptContext } from '#src/discuss/shell/prompts.js';

function createPromptContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    selfName: 'alpha',
    state: {
      session_id: 'discuss-1',
      topic: 'Should the city ban private cars downtown?',
      status: 'bidding',
      step: 2,
      epoch: 1,
      max_epochs: 3,
      quota_per_epoch: 2,
      cold_start: false,
      agents: {
        alpha: {
          display_name: 'Alpha Analyst',
          persona: 'Supports strict traffic limits.\nFocuses on emissions and transit throughput.',
          participation: 'required',
          quota_remaining: 1,
          total_speaks: 1,
          fallback_used: false,
          banned: false,
        },
        beta: {
          display_name: 'Beta Builder',
          persona: 'Prefers market incentives over bans.\nEmphasizes phased implementation.',
          participation: 'required',
          quota_remaining: 2,
          total_speaks: 0,
          fallback_used: false,
          banned: false,
        },
        gamma: {
          display_name: 'Gamma Skeptic',
          persona: 'Worries about small business disruption.\nPresses for operational details.',
          participation: 'observer',
          quota_remaining: 2,
          total_speaks: 0,
          fallback_used: false,
          banned: false,
        },
      },
      current_bids: { alpha: null, beta: null, gamma: null },
      current_thoughts: {},
      pending_bidders: ['alpha', 'beta', 'gamma'],
      current_speaker: null,
      speaker_type: null,
      epoch_summary_written: null,
      created_at: '2026-03-10T00:00:00.000Z',
      last_activity_at: '2026-03-10T00:00:00.000Z',
      last_speech_step: 1,
      bid_release_step: 1,
      end_reason_content: null,
      transcript: [],
      bid_threshold: 50,
      min_bid_delay_ms: 0,
    },
    priorSpeech: null,
    mustAnswer: null,
    ...overrides,
  };
}

describe('discuss prompts', () => {
  it('builds the first-turn instruction with the JSON contract, full self persona, and brief participant summaries', () => {
    const prompt = buildFirstTurnInstruction(createPromptContext());

    expect(prompt).toContain('Respond with ONLY valid JSON in this exact shape: {"score": 0-100, "thought": "..."}');
    expect(prompt).toContain(
      'You are Alpha Analyst.\n\nSupports strict traffic limits.\nFocuses on emissions and transit throughput.',
    );
    expect(prompt).toContain('Other participants:');
    expect(prompt).toContain('- Beta Builder (beta): Prefers market incentives over bans.');
    expect(prompt).toContain('- Gamma Skeptic (gamma): Worries about small business disruption.');
  });

  it('includes prior speech content for listener bids', () => {
    const prompt = buildBidPrompt(
      createPromptContext({
        priorSpeech: {
          speaker: 'beta',
          content: 'A total ban is too blunt; phase it in block by block.',
        },
      }),
    );

    expect(prompt).toContain('Most recent speech from beta:');
    expect(prompt).toContain('A total ban is too blunt; phase it in block by block.');
  });

  it('does not echo the agent’s own prior speech back in speaker bids', () => {
    const prompt = buildBidPrompt(
      createPromptContext({
        priorSpeech: {
          speaker: 'alpha',
          content: 'My own previous speech should not appear here.',
        },
      }),
    );

    expect(prompt).not.toContain('My own previous speech should not appear here.');
    expect(prompt).not.toContain('Most recent speech from alpha:');
  });

  it('builds speech prompts as turn-to-speak text without bid JSON scaffolding', () => {
    const prompt = buildSpeechPrompt(
      createPromptContext({
        mustAnswer: 'Address whether delivery vehicles get an exemption.',
      }),
    );

    expect(prompt).toContain('It is your turn to speak now.');
    expect(prompt).toContain('Respond with your speech text only.');
    expect(prompt).toContain('Address whether delivery vehicles get an exemption.');
    expect(prompt).not.toContain('"score"');
    expect(prompt).not.toContain('0-100');
  });
});
