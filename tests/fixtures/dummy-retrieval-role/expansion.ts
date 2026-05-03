import type { Expansion } from '#src/expansion/contract.js';
import type { RetrievalRole } from '#src/kb/search/contract.js';
import { dummyRetrievalRoleDescriptor } from './manifest.js';

export const dummyRetrievalRole: RetrievalRole = {
  id: dummyRetrievalRoleDescriptor.id,
  descriptor: dummyRetrievalRoleDescriptor,
  async search(ctx) {
    return {
      hits: [
        {
          entryId: 'note:dummy-test-role',
          slug: 'dummy-test-role',
          kind: 'note',
          title: 'Dummy Test Role Hit',
          tags: ['dummy'],
          principles: [],
          rank: 1,
          score: 1,
          document: {
            entryId: 'note:dummy-test-role',
            slug: 'dummy-test-role',
            kind: 'note',
            freshness: 'fresh',
            title: 'Dummy Test Role Hit',
            body: `Dummy retrieval role matched ${ctx.rawQuery}.`,
            tags: ['dummy'],
            principles: [],
          },
        },
      ],
    };
  },
};

const expansion: Expansion = (host) => {
  host.registerRetrievalRole(dummyRetrievalRole, host.scope);
};

export default expansion;
