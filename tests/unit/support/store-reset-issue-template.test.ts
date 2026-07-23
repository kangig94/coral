import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type IssueForm = {
  readonly body?: readonly {
    readonly type?: string;
    readonly id?: string;
    readonly attributes?: {
      readonly value?: string;
      readonly label?: string;
      readonly description?: string;
      readonly options?: readonly { readonly label?: string; readonly required?: boolean }[];
    };
    readonly validations?: { readonly required?: boolean };
  }[];
};

describe('store-reset GitHub issue template', () => {
  it('accepts a generated report or fixed error and requires context with explicit disclosure prohibitions', () => {
    const template = parse(
      readFileSync(join(process.cwd(), '.github', 'ISSUE_TEMPLATE', 'store-reset.yml'), 'utf8'),
    ) as IssueForm;
    const body = template.body ?? [];
    const requiredTextareas = body
      .filter((entry) => entry.type === 'textarea' && entry.validations?.required === true)
      .map((entry) => entry.id);
    const allText = JSON.stringify(body);
    const confirmations = body
      .find((entry) => entry.id === 'safe_disclosure')
      ?.attributes?.options?.filter((option) => option.required === true)
      .map((option) => option.label)
      .join(' ');

    expect(requiredTextareas).toEqual(['report', 'reproduction', 'update_context']);
    expect(allText).toContain('coral-cli backend store-reset report <incident-id>');
    expect(allText).toContain('fixed text error output');
    expect(confirmations).toContain('DB, WAL, or SHM');
    expect(confirmations).toContain('.env');
    expect(confirmations).toContain('credentials');
    expect(confirmations).toContain('unredacted logs');
  });
});
