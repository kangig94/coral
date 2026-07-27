import { CommanderError } from 'commander';
import { z, ZodError } from 'zod';

import { installErrorSchema, type InstallError } from '../../expansion/rpc-contract.js';
import { kbCapabilityNameSchema } from '../../kb/capability/contract.js';
import { isRecord } from '../../infra/json.js';
import { documentedCoralSetupError, serializeCoralSetupError } from '../../runtime/errors.js';
import { readDefaultExpansionCatalog } from './catalog.js';

export const expansionArgsSchema = z
  .object({
    name: z.string().min(1).optional(),
  })
  .strict();
export type ExpansionArgs = z.infer<typeof expansionArgsSchema>;

const INVALID_USAGE_REMEDIATION = "Retry with valid expansion command arguments or run 'coral-cli expansion --help'.";
const UNKNOWN_ERROR_REMEDIATION =
  'Retry once, then report the full JSON error and check the coordinator logs if it persists.';
const CATALOG_UNAVAILABLE_MESSAGE = /unable to open database file/i;

function nextCause(error: unknown): unknown {
  if (error instanceof Error) {
    return error.cause;
  }

  if (isRecord(error) && 'cause' in error) {
    return error.cause;
  }

  return undefined;
}

function findStructuredSetupError(error: unknown): ReturnType<typeof serializeCoralSetupError> {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    const structured = serializeCoralSetupError(current);
    if (structured !== null) {
      return structured;
    }

    if (!(current instanceof Error) && !isRecord(current)) {
      break;
    }

    seen.add(current);
    current = nextCause(current);
  }

  return null;
}

function normalizeMessage(message: unknown, fallback = 'Unknown error'): string {
  const rendered = typeof message === 'string' ? message : String(message);
  return rendered.length > 0 ? rendered : fallback;
}

function formatZodUserMessage(error: ZodError): string {
  if (error.issues.length === 0) {
    return 'Expansion command validation failed.';
  }

  const details = error.issues
    .map((issue) => {
      if (issue.message.startsWith('--')) {
        return issue.message;
      }

      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');

  return `Expansion command validation failed: ${details}`;
}

function formatCommanderUserMessage(error: CommanderError): string {
  const detail = error.message.replace(/^error:\s*/u, '').trim();
  if (detail.length === 0 || detail === '(outputHelp)') {
    return 'Expansion command validation failed.';
  }

  return `Expansion command validation failed: ${detail}`;
}

function finalizeInstallError(error: InstallError): InstallError {
  return installErrorSchema.parse(error);
}

function readDefaultExpansionCatalogForInstallErrorRendering() {
  try {
    return readDefaultExpansionCatalog();
  } catch (error) {
    if (serializeCoralSetupError(error) !== null) {
      return [];
    }
    if (error instanceof Error && CATALOG_UNAVAILABLE_MESSAGE.test(error.message)) {
      return [];
    }
    throw error;
  }
}

function bindingRequiredInstallError(
  structured: NonNullable<ReturnType<typeof serializeCoralSetupError>>,
): InstallError | null {
  if (structured.code !== 'binding_required') {
    return null;
  }

  const binding = typeof structured.context?.binding === 'string' ? structured.context.binding : 'unknown-binding';
  const requiredBy =
    typeof structured.context?.requiredBy === 'string' ? structured.context.requiredBy : 'this expansion';
  const parsedBinding = kbCapabilityNameSchema.safeParse(binding);
  const peers = parsedBinding.success
    ? readDefaultExpansionCatalogForInstallErrorRendering()
        .filter((entry) => entry.fills?.includes(parsedBinding.data))
        .map((entry) => entry.id)
    : [];
  const availablePeers = peers.length > 0 ? peers.join(', ') : 'none';

  return finalizeInstallError({
    status: 'error',
    code: structured.code,
    userMessage: `Cannot equip '${requiredBy}' — it requires '${binding}' to be bound. Available Expansions for '${binding}': ${availablePeers}.`,
    remediation: `Run 'coral-cli expansion equip <name>' for an engine that fills '${binding}', then retry.`,
    ...(structured.context === undefined ? {} : { context: structured.context }),
    ...(peers.length === 0 ? {} : { suggestions: peers }),
  });
}

function isUserInputError(error: unknown): error is Error & { cause: ZodError } {
  return error instanceof Error && error.name === 'UserInputError' && error.cause instanceof ZodError;
}

export function encodeInstallError(err: unknown): InstallError {
  const structured = findStructuredSetupError(err);
  if (structured !== null) {
    const bindingRequired = bindingRequiredInstallError(structured);
    if (bindingRequired !== null) {
      return bindingRequired;
    }

    return finalizeInstallError({
      status: 'error',
      code: structured.code,
      userMessage: structured.userMessage,
      remediation: structured.remediation,
      ...(structured.context === undefined ? {} : { context: structured.context }),
    });
  }

  if (isUserInputError(err)) {
    return finalizeInstallError({
      status: 'error',
      code: 'invalid_usage',
      userMessage: formatZodUserMessage(err.cause),
      remediation: INVALID_USAGE_REMEDIATION,
    });
  }

  if (err instanceof ZodError) {
    const documented = documentedCoralSetupError('installer_payload_invalid');
    return finalizeInstallError({
      status: 'error',
      code: documented.code,
      userMessage: documented.userMessage,
      remediation: documented.remediation,
    });
  }

  if (err instanceof CommanderError) {
    return finalizeInstallError({
      status: 'error',
      code: 'invalid_usage',
      userMessage: formatCommanderUserMessage(err),
      remediation: INVALID_USAGE_REMEDIATION,
    });
  }

  if (err instanceof Error) {
    return finalizeInstallError({
      status: 'error',
      code: 'unknown_error',
      userMessage: normalizeMessage(err.message, err.name),
      remediation: UNKNOWN_ERROR_REMEDIATION,
    });
  }

  return finalizeInstallError({
    status: 'error',
    code: 'unknown_error',
    userMessage: normalizeMessage(err),
    remediation: UNKNOWN_ERROR_REMEDIATION,
  });
}
