import { describe, expect, it } from 'vitest';

// @ts-expect-error - statusline hooks are executable .mjs files without TS declarations.
import { composeCoralThirdLine, renderTextProjectionIndicator } from '../../../clients/skills/statusline/coral-hud.mjs';

function visible(value: string): string {
  // eslint-disable-next-line no-control-regex -- Strips ANSI SGR escape sequences from hook output.
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('coral-hud text projection indicator', () => {
  it('hides the indicator when idle', () => {
    expect(renderTextProjectionIndicator('idle')).toBeNull();
    expect(renderTextProjectionIndicator(undefined)).toBeNull();
  });

  it('renders coarse fetch and reindex labels', () => {
    expect(visible(renderTextProjectionIndicator('fetching'))).toBe('fetching');
    expect(visible(renderTextProjectionIndicator('reindexing'))).toBe('reindexing');
  });

  it('right-aligns the active indicator on the Coral line', () => {
    const indicator = renderTextProjectionIndicator('reindexing');
    const rendered = composeCoralThirdLine('coral gear:1', indicator, 'last user input', 32);

    expect(visible(rendered)).toBe('coral gear:1          reindexing');
    expect(visible(rendered)).not.toContain('last user input');
  });
});
