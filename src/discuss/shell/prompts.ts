import type { AgentState, DiscussState } from '../session-types.js';

export type PromptContext = {
  selfName: string;
  state: DiscussState;
  priorSpeech: { speaker: string; content: string } | null;
  mustAnswer: string | null;
};

function getAgent(selfName: string, agents: Record<string, AgentState>): AgentState {
  const agent = agents[selfName];
  if (!agent) {
    throw new Error(`Unknown discuss agent: ${selfName}`);
  }
  return agent;
}

function joinSections(sections: Array<string | null | undefined>): string {
  return sections.filter((section): section is string => Boolean(section && section.trim())).join('\n\n');
}

function firstPersonaLine(persona: string): string {
  return (
    persona
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

/** Full self-persona block for this agent */
function selfPersonaBlock(agentName: string, agents: Record<string, AgentState>): string {
  const agent = getAgent(agentName, agents);
  return `You are ${agent.display_name}.\n\n${agent.persona}`;
}

/** Brief summary of other participants (name + position brief only) */
function otherParticipantsBlock(selfName: string, agents: Record<string, AgentState>): string {
  const others = Object.entries(agents)
    .filter(([name]) => name !== selfName)
    .map(([name, agent]) => `- ${agent.display_name} (${name}): ${firstPersonaLine(agent.persona)}`)
    .join('\n');
  return others ? `Other participants:\n${others}` : '';
}

function priorSpeechBlock(ctx: PromptContext): string {
  if (!ctx.priorSpeech || ctx.priorSpeech.speaker === ctx.selfName) {
    return '';
  }
  return `Most recent speech from ${ctx.priorSpeech.speaker}:\n${ctx.priorSpeech.content}`;
}

function mustAnswerBlock(mustAnswer: string | null): string {
  if (!mustAnswer) {
    return '';
  }
  return `If you speak, you must answer this follow-up:\n${mustAnswer}`;
}

function bidContractBlock(): string {
  return joinSections([
    'Decide how strongly you should bid to speak next in this discussion.',
    'Respond with ONLY valid JSON in this exact shape: {"score": 0-100, "thought": "..."}',
    'Use "score" for your urgency to speak, where 0 means do not speak and 100 means speak immediately.',
    'Use "thought" for a brief private justification.',
    'Do not add any text before or after the JSON. Do not use markdown or code fences.',
  ]);
}

function bidPromptSections(ctx: PromptContext): string[] {
  return [
    `Discussion topic:\n${ctx.state.topic}`,
    selfPersonaBlock(ctx.selfName, ctx.state.agents),
    otherParticipantsBlock(ctx.selfName, ctx.state.agents),
    priorSpeechBlock(ctx),
    mustAnswerBlock(ctx.mustAnswer),
    bidContractBlock(),
  ];
}

/** Bid prompt — returns JSON only */
export function buildBidPrompt(ctx: PromptContext): string {
  return joinSections(bidPromptSections(ctx));
}

/** Speech prompt — returns speech text only */
export function buildSpeechPrompt(ctx: PromptContext): string {
  return joinSections([
    `Discussion topic:\n${ctx.state.topic}`,
    selfPersonaBlock(ctx.selfName, ctx.state.agents),
    mustAnswerBlock(ctx.mustAnswer),
    'It is your turn to speak now.',
    'Respond with your speech text only. Do not include JSON, analysis, or code fences.',
  ]);
}

/** First-turn system instruction (used as `instruction` field in JobLaunchRequest) */
export function buildFirstTurnInstruction(ctx: PromptContext): string {
  return joinSections([
    'You are participating in a backend-managed multi-agent discussion. Follow this bidding contract.',
    ...bidPromptSections(ctx),
  ]);
}
