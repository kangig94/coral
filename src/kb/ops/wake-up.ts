import { join } from 'node:path';

import type { KbRuntime } from '../contract.js';
import { extractBody, parseWikiBody, parseWikiFrontmatter } from '../corpus/frontmatter.js';

type WakeUpRuntime = Pick<KbRuntime, 'markdownRoot' | 'storagePort' | 'wikiPath'>;

function readIdentity(kb: Pick<WakeUpRuntime, 'markdownRoot' | 'storagePort'>): string | null {
  const identityPath = join(kb.markdownRoot, 'identity.md');
  if (!kb.storagePort.existsSync(identityPath)) {
    return null;
  }
  return kb.storagePort.readFileSync(identityPath, 'utf-8').trimEnd();
}

export async function generateWakeUpPacket(kb: WakeUpRuntime, projectSlug: string | undefined): Promise<string> {
  if (projectSlug === undefined) {
    return '';
  }

  let wikiChunk = '';
  const wikiPath = kb.wikiPath(projectSlug);
  if (kb.storagePort.existsSync(wikiPath)) {
    const raw = kb.storagePort.readFileSync(wikiPath, 'utf-8');
    const meta = parseWikiFrontmatter(raw);
    const sections = parseWikiBody(extractBody(raw));
    wikiChunk = `## ${projectSlug} (${meta.updatedAt})\n${sections.understanding}\n`;
  }

  const identity = readIdentity(kb);
  if (identity === null || identity.length === 0) {
    return wikiChunk;
  }

  return `${identity}\n\n${wikiChunk}`;
}
