import type { ControversyAxis } from '../discuss/schemas.js';

export type JsonObject = Record<string, unknown>;

export type DiscussStartAgentInput = {
  name: string;
  persona: string;
  participation?: string;
  provider?: string;
  model?: string;
};

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitCommaSeparated(spec: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of spec) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (char === ',' && !inQuotes) {
      segments.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (inQuotes) {
    throw new Error('Unclosed quote in spec');
  }

  segments.push(current.trim());
  return segments;
}

function parseScalarValue(rawValue: string): string {
  const value = rawValue.trim();

  if (!value.startsWith('"')) {
    return value;
  }

  if (!value.endsWith('"')) {
    throw new Error('Unclosed quote in spec');
  }

  return value.slice(1, -1);
}

export function parseKeyValuePairs(spec: string): Record<string, string> {
  const pairs: Record<string, string> = {};

  for (const segment of splitCommaSeparated(spec)) {
    const equalsIndex = segment.indexOf('=');
    if (equalsIndex === -1) {
      throw new Error(`Expected key=value segment, received "${segment}"`);
    }

    const key = segment.slice(0, equalsIndex).trim();
    if (key.length === 0) {
      throw new Error('Expected key before =');
    }

    if (Object.hasOwn(pairs, key)) {
      throw new Error(`Duplicate key: ${key}`);
    }

    pairs[key] = parseScalarValue(segment.slice(equalsIndex + 1));
  }

  return pairs;
}

export function parseAgentSpec(spec: string): DiscussStartAgentInput {
  const pairs = parseKeyValuePairs(spec);

  if (!Object.hasOwn(pairs, 'name')) {
    throw new Error('Agent spec requires name');
  }

  if (!Object.hasOwn(pairs, 'persona')) {
    throw new Error('Agent spec requires persona');
  }

  return {
    name: pairs.name,
    persona: pairs.persona,
    ...(pairs.participation === undefined ? {} : { participation: pairs.participation }),
    ...(pairs.provider === undefined ? {} : { provider: pairs.provider }),
    ...(pairs.model === undefined ? {} : { model: pairs.model }),
  };
}

export function parseAxisSpec(spec: string): ControversyAxis {
  const segments = splitCommaSeparated(spec);
  let axis: string | undefined;
  let positions: string[] | undefined;
  let collectingPositions = false;

  for (const segment of segments) {
    const equalsIndex = segment.indexOf('=');

    if (equalsIndex === -1) {
      if (!collectingPositions || positions === undefined) {
        throw new Error(`Expected key=value segment, received "${segment}"`);
      }

      positions.push(parseScalarValue(segment));
      continue;
    }

    const key = segment.slice(0, equalsIndex).trim();
    const rawValue = segment.slice(equalsIndex + 1);

    if (key === 'axis') {
      if (axis !== undefined) {
        throw new Error('Duplicate key: axis');
      }

      axis = parseScalarValue(rawValue);
      collectingPositions = false;
      continue;
    }

    if (key === 'positions') {
      if (positions !== undefined) {
        throw new Error('Duplicate key: positions');
      }

      const trimmedValue = rawValue.trim();
      positions = trimmedValue.startsWith('"')
        ? parseScalarValue(trimmedValue).split(',').map((position) => position.trim())
        : [parseScalarValue(trimmedValue)];
      collectingPositions = !trimmedValue.startsWith('"');
      continue;
    }

    throw new Error(`Unknown axis key: ${key}`);
  }

  if (axis === undefined) {
    throw new Error('Axis spec requires axis');
  }

  if (positions === undefined) {
    throw new Error('Axis spec requires positions');
  }

  return { axis, positions };
}

async function readStdin(): Promise<string> {
  if (process.stdin.readableEnded) {
    return '';
  }

  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function parseInputJson(flag: string | undefined): Promise<JsonObject> {
  if (flag === undefined) {
    return {};
  }

  if (flag !== '-') {
    throw new Error('--input-json only accepts -');
  }

  const parsed: unknown = JSON.parse(await readStdin());

  if (!isJsonObject(parsed)) {
    throw new Error('--input-json must be a JSON object');
  }

  return parsed;
}
