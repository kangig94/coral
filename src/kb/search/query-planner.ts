import type { KbSearchMode } from '../entry-types.js';
import type { RegisteredRetrievalRole, RoleExecutionRegistryView, RoleQueryContext } from './contract.js';

// Stage 1 simplification: fallback invocations are a flat optional list.
// The plan originally proposed a discriminated `RoleFallbackInvocation`
// with explicit `trigger`/`primaryRoleId`. That is reserved for Stage 2
// when reranker phase introduces a second trigger. Until then, the
// runner detects fallback condition from the failure rule (Rule 2).
export type KbSearchIntent = KbSearchMode | 'auto';

export type RoleInvocation = {
  readonly registeredRole: RegisteredRetrievalRole;
  readonly required: boolean;
  readonly skipReason?: string;
};

export type QueryPlan = {
  readonly primaryInvocations: RoleInvocation[];
  readonly fallbackInvocations?: RoleInvocation[];
};

export interface QueryPlanner {
  plan(intent: KbSearchIntent, registry: RoleExecutionRegistryView, ctx: RoleQueryContext): QueryPlan;
}

function supportsScope(registeredRole: RegisteredRetrievalRole, ctx: RoleQueryContext): boolean {
  return registeredRole.descriptor.supportsScopes.includes(ctx.scope);
}

function primaryTag(registeredRole: RegisteredRetrievalRole): string | undefined {
  return registeredRole.descriptor.tags[0];
}

function hasTag(registeredRole: RegisteredRetrievalRole, tag: string): boolean {
  return registeredRole.descriptor.tags.includes(tag);
}

function isRequiredCoreContributor(registeredRole: RegisteredRetrievalRole, primaryTags: ReadonlySet<string>): boolean {
  const tag = primaryTag(registeredRole);
  return registeredRole.criticality === 'core' && tag !== undefined && primaryTags.has(tag);
}

function invocation(registeredRole: RegisteredRetrievalRole, required: boolean): RoleInvocation {
  return { registeredRole, required };
}

export function createQueryPlanner(): QueryPlanner {
  return {
    plan(intent, registry, ctx) {
      const registeredRoles = registry.list();

      if (intent === 'text') {
        return {
          primaryInvocations: registeredRoles
            .filter((registeredRole) => hasTag(registeredRole, 'lexical') && supportsScope(registeredRole, ctx))
            .map((registeredRole) =>
              invocation(registeredRole, isRequiredCoreContributor(registeredRole, new Set(['lexical']))),
            ),
        };
      }

      if (intent === 'vector') {
        const fallbackInvocations = registeredRoles
          .filter((registeredRole) => hasTag(registeredRole, 'lexical') && supportsScope(registeredRole, ctx))
          .map((registeredRole) => invocation(registeredRole, false));

        return {
          primaryInvocations: registeredRoles
            .filter((registeredRole) => hasTag(registeredRole, 'semantic') && supportsScope(registeredRole, ctx))
            .map((registeredRole) =>
              invocation(registeredRole, isRequiredCoreContributor(registeredRole, new Set(['semantic']))),
            ),
          ...(fallbackInvocations.length === 0 ? {} : { fallbackInvocations }),
        };
      }

      if (intent === 'hybrid') {
        return {
          primaryInvocations: registeredRoles
            .filter((registeredRole) => supportsScope(registeredRole, ctx))
            .map((registeredRole) =>
              invocation(registeredRole, isRequiredCoreContributor(registeredRole, new Set(['lexical', 'semantic']))),
            ),
        };
      }

      return {
        primaryInvocations: registeredRoles
          .filter((registeredRole) => supportsScope(registeredRole, ctx))
          .map((registeredRole) =>
            invocation(registeredRole, isRequiredCoreContributor(registeredRole, new Set(['lexical']))),
          ),
      };
    },
  };
}
