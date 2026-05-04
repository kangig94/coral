import type { KbRuntime } from '../contract.js';
import { extractBody, parseWikiBody, parseWikiFrontmatter } from '../corpus/frontmatter.js';

type WakeUpRuntime = Pick<KbRuntime, 'storagePort' | 'wikiPath'>;

export async function generateWakeUpPacket(kb: WakeUpRuntime, projectSlug: string | undefined): Promise<string> {
  if (projectSlug === undefined) {
    return '';
  }

  const wikiPath = kb.wikiPath(projectSlug);
  if (!kb.storagePort.existsSync(wikiPath)) {
    return '';
  }

  const raw = kb.storagePort.readFileSync(wikiPath, 'utf-8');
  const meta = parseWikiFrontmatter(raw);
  const sections = parseWikiBody(extractBody(raw));
  return `## project wiki: ${projectSlug} (${meta.updatedAt})\n${sections.understanding}\n`;
}
