import { CoralSetupError, serializeCoralSetupError } from '../../runtime/errors.js';
import type { KbRuntime } from '../contract.js';
import type { KbSearchMode, KbSearchResponse, KbSearchScope } from '../entry-types.js';
import {
  buildSearchResponse,
  createSearchExecutionContext,
  createSearchRequest,
  isVectorBindingName,
  resolveSearchRuntime,
  runRetrieval,
  type VectorBindingName,
} from './search-runner.js';

function missingBindingRemediation(binding: VectorBindingName): string {
  return binding === 'kb.embedding'
    ? "Run `coral-cli expansion list` to find an engine that fills 'kb.embedding', then `coral-cli expansion equip <name>`. FTS-only search continues to work zero-config."
    : "Run `coral-cli expansion list` to find an engine that fills 'kb.vector', then `coral-cli expansion equip <name>`. FTS-only search continues to work zero-config.";
}

function rethrowAsMissingVectorBinding(error: unknown): never {
  const setupError = serializeCoralSetupError(error);
  const binding = setupError?.context?.binding;
  if (
    setupError === null ||
    setupError.code !== 'binding_empty' ||
    typeof binding !== 'string' ||
    !isVectorBindingName(binding)
  ) {
    throw error;
  }

  throw Object.assign(
    new CoralSetupError({
      code: 'binding_empty',
      userMessage: `Vector search needs ${binding}.`,
      remediation: missingBindingRemediation(binding),
      context: { binding },
    }),
    { binding, cause: error },
  );
}

export async function searchKb(
  rt: KbRuntime,
  query: string,
  top_k = 20,
  scope: KbSearchScope = 'all',
  mode?: KbSearchMode,
): Promise<KbSearchResponse> {
  const request = createSearchRequest(query, top_k, scope, mode);
  const resolution = resolveSearchRuntime(rt, request);
  if (resolution.kind === 'response') {
    return resolution.response;
  }

  const ctx = createSearchExecutionContext(rt, request, resolution.runtime, {
    rethrowMissingVectorBinding: rethrowAsMissingVectorBinding,
  });
  const retrieval = await runRetrieval(ctx);
  return buildSearchResponse(ctx, retrieval);
}
