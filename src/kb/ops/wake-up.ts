import { join } from 'node:path';

import type { KbRuntime } from '../contract.js';
import { parseWikiBody } from '../corpus/frontmatter.js';
import type { KbProjectionInput, KbProjectionRecord } from '../projection-input-contract.js';

type WakeUpRuntime = Pick<KbRuntime, 'markdownRoot' | 'storagePort' | 'corpusProjectionReader'>;

function readIdentity(kb: Pick<WakeUpRuntime, 'markdownRoot' | 'storagePort'>): string | null {
  const identityPath = join(kb.markdownRoot, 'identity.md');
  if (!kb.storagePort.existsSync(identityPath)) {
    return null;
  }
  return kb.storagePort.readFileSync(identityPath, 'utf-8').trimEnd();
}

function projectScopedWikiRecords(
  projectionInput: KbProjectionInput,
  project: string,
): Array<Extract<KbProjectionRecord, { kind: 'wiki' }>> {
  return projectionInput.records
    .filter(
      (record): record is Extract<KbProjectionRecord, { kind: 'wiki' }> =>
        record.kind === 'wiki' && record.entry.project === project,
    )
    .sort(
      (left, right) =>
        right.entry.updatedAt.localeCompare(left.entry.updatedAt) || left.entry.slug.localeCompare(right.entry.slug),
    );
}

export async function generateWakeUpPacket(kb: KbRuntime, project: string | undefined): Promise<string> {
  if (project === undefined) {
    return '';
  }

  const projectionInput = await kb.corpusProjectionReader.prepareCurrentProjectionInput();
  const wikiChunks = projectScopedWikiRecords(projectionInput, project)
    .map((record) => {
      const sections = parseWikiBody(record.body);
      return `## ${record.entry.slug} (${record.entry.updatedAt})\n${sections.understanding}\n\n`;
    })
    .join('');

  const identity = readIdentity(kb);
  if (identity === null || identity.length === 0) {
    return wikiChunks;
  }

  return `${identity}\n\n${wikiChunks}`;
}
