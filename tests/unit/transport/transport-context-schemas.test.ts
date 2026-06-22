import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';

import { sessionCreateSchema } from '#src/sessions/command-schemas.js';
import {
  discussSessionBidRequestSchema,
  discussSessionCreateRequestSchema,
  discussSessionSpeechRequestSchema,
} from '#src/transport/rpc/discuss.js';
import { workflowRequestSchema } from '#src/transport/rpc/workflow.js';
import {
  kbCommunitySetSummaryRequestSchema,
  kbMemoCreateRequestSchema,
  kbMemoDeleteRequestSchema,
  kbNoteCreateRequestSchema,
  kbNoteDeleteRequestSchema,
  kbNoteUpdateRequestSchema,
  kbReindexRequestSchema,
  kbSourceCreateRequestSchema,
  kbSourceDeleteRequestSchema,
  kbWikiAdoptRequestSchema,
  kbWikiCiteRequestSchema,
  kbWikiCreateRequestSchema,
  kbWikiDeleteRequestSchema,
  kbWikiLinkRequestSchema,
  kbWikiRewriteRequestSchema,
  kbWikiUnlinkRequestSchema,
} from '#src/kb/tool-contracts.js';

type SchemaCase = {
  name: string;
  schema: ZodTypeAny;
  body: Record<string, unknown>;
};

const transportContext = {
  projectRoot: '/tmp/project',
  owner: 'session-abc.123',
  effort: 'high',
  claudeModelCap: 'sonnet',
  networkEnv: { HTTPS_PROXY: 'http://proxy:8443' },
};

const kbMutationContext = {
  ...transportContext,
  jobId: 'job-1',
  sessionId: 'session-1',
};

function expectAccepted({ name, schema, body }: SchemaCase): void {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${name} rejected transport context: ${parsed.error.message}`);
  }
  expect(parsed.success).toBe(true);
}

describe('transport context request schemas', () => {
  it.each<SchemaCase>([
    {
      name: 'sessions.create',
      schema: sessionCreateSchema,
      body: {
        provider: 'claude',
        prompt: 'hello',
        ...transportContext,
      },
    },
    {
      name: 'workflow.run',
      schema: workflowRequestSchema,
      body: {
        expression: 'architect',
        startPrompt: 'hello',
        ...transportContext,
      },
    },
    {
      name: 'discuss.session.create',
      schema: discussSessionCreateRequestSchema,
      body: {
        topic: 'Topic',
        agents: [
          { name: 'alice', persona: 'Alice' },
          { name: 'bob', persona: 'Bob' },
        ],
        ...transportContext,
      },
    },
    {
      name: 'discuss.session.bid',
      schema: discussSessionBidRequestSchema,
      body: {
        sessionId: 'discuss-1',
        agent_name: 'alice',
        score: 50,
        thought: 'ready',
        ...transportContext,
      },
    },
    {
      name: 'discuss.session.speech',
      schema: discussSessionSpeechRequestSchema,
      body: {
        sessionId: 'discuss-1',
        agent_name: 'alice',
        content: 'hello',
        ...transportContext,
      },
    },
  ])('$name accepts buildTransportContextBody fields', expectAccepted);

  it.each<SchemaCase>([
    {
      name: 'kb.note.create',
      schema: kbNoteCreateRequestSchema,
      body: {
        memo: 'memo-1',
        title: 'Title',
        content: 'body',
        domain: 'domain',
        topic: 'topic',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.note.update',
      schema: kbNoteUpdateRequestSchema,
      body: {
        slug: 'note-1',
        content: 'updated',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.note.delete',
      schema: kbNoteDeleteRequestSchema,
      body: {
        slug: 'note-1',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.wiki.create',
      schema: kbWikiCreateRequestSchema,
      body: {
        slug: 'wiki-1',
        title: 'Wiki',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.wiki.rewrite',
      schema: kbWikiRewriteRequestSchema,
      body: {
        slug: 'wiki-1',
        understandingFile: '/tmp/understanding.md',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.wiki.link',
      schema: kbWikiLinkRequestSchema,
      body: {
        slug: 'wiki-1',
        refs: ['ref-1'],
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.wiki.unlink',
      schema: kbWikiUnlinkRequestSchema,
      body: {
        slug: 'wiki-1',
        refs: ['ref-1'],
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.wiki.cite',
      schema: kbWikiCiteRequestSchema,
      body: {
        slug: 'wiki-1',
        ref: 'ref-1',
        evidenceFile: '/tmp/evidence.md',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.wiki.adopt',
      schema: kbWikiAdoptRequestSchema,
      body: {
        slug: 'wiki-1',
        memo: 'memo-1',
        title: 'Title',
        content: 'body',
        domain: 'domain',
        topic: 'topic',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.wiki.delete',
      schema: kbWikiDeleteRequestSchema,
      body: {
        slug: 'wiki-1',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.source.create',
      schema: kbSourceCreateRequestSchema,
      body: {
        filePath: '/tmp/source.md',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.source.delete',
      schema: kbSourceDeleteRequestSchema,
      body: {
        slug: 'source-1',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.community.set-summary',
      schema: kbCommunitySetSummaryRequestSchema,
      body: {
        slug: 'community-1',
        summary: 'summary',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.memo.create',
      schema: kbMemoCreateRequestSchema,
      body: {
        topic: 'topic',
        content: 'memo',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.memo.delete',
      schema: kbMemoDeleteRequestSchema,
      body: {
        pattern: '2026-*',
        ...kbMutationContext,
      },
    },
    {
      name: 'kb.reindex',
      schema: kbReindexRequestSchema,
      body: {
        async: true,
        ...kbMutationContext,
      },
    },
  ])('$name accepts buildKbMutationTransportContextBody fields', expectAccepted);
});
