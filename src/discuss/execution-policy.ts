import { DEFAULT_DISCUSS_PROVIDER } from './command-schemas.js';

export type DiscussAgentProviderSelection = {
  readonly participation?: 'required' | 'observer';
  readonly provider?: string;
  readonly model?: string;
};

export type DiscussAgentExecutionSelection =
  | { readonly manual: true }
  | { readonly manual: false; readonly provider: string; readonly model: string };

/** Resolve one discussion participant into its provider execution policy. */
export function discussAgentExecution(agent: DiscussAgentProviderSelection): DiscussAgentExecutionSelection {
  const manualObserver =
    (agent.participation ?? 'required') === 'observer' && agent.provider === undefined && agent.model === undefined;
  return manualObserver
    ? { manual: true }
    : {
        manual: false,
        provider: agent.provider ?? DEFAULT_DISCUSS_PROVIDER,
        model: agent.model ?? '',
      };
}

/** Return every provider required by a discussion roster, in first-use order. */
export function discussProviderNames(agents: readonly DiscussAgentProviderSelection[]): string[] {
  const providers: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    const execution = discussAgentExecution(agent);
    if (!execution.manual && !seen.has(execution.provider)) {
      seen.add(execution.provider);
      providers.push(execution.provider);
    }
  }
  return providers;
}
