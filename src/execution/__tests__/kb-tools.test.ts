import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SearchMod from '../../kb/search.js';
import type * as SourceStoreMod from '../../kb/source-store.js';
import {
  handleKbDelete,
  handleKbMemo,
  handleKbMemoDelete,
  handleKbMemoList,
  handleKbMemoPurge,
  handleKbPrinciples,
  handleKbPromote,
  handleKbRead,
  handleKbReindex,
  handleKbSearch,
  handleKbSourceDelete,
  handleKbSourceImport,
  handleKbSourceList,
  handleKbUpdate,
  type KbSubsystem,
} from '../kb-tools.js';
import type { CallerContext } from '../request-context.js';

const mockState = vi.hoisted(() => ({
  searchKb: vi.fn(),
  persistPreparedSource: vi.fn(),
}));

vi.mock('../../kb/search.js', async () => {
  const actual = await vi.importActual<typeof SearchMod>('../../kb/search.js');
  return {
    ...actual,
    searchKb: mockState.searchKb,
  };
});

vi.mock('../../kb/source-store.js', async () => {
  const actual = await vi.importActual<typeof SourceStoreMod>('../../kb/source-store.js');
  return {
    ...actual,
    persistPreparedSource: mockState.persistPreparedSource,
  };
});

function createKbSubsystem(): KbSubsystem {
  return {
    kb: {} as never,
    curateScheduler: {
      start: vi.fn(async () => {}),
      schedule: vi.fn(),
      scheduleDeferredCommit: vi.fn(),
      stop: vi.fn(async () => {}),
      isRunning: () => false,
    },
  };
}

const testContext: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
  coralEnv: {},
};

function expectInvalidRequest(result: unknown): void {
  expect(result).toMatchObject({
    ok: false,
    code: 'invalid_request',
  });
}

describe('kb-tools', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['search', () => handleKbSearch({ query: 'contracts', extra: true }, createKbSubsystem())],
    ['read', () => handleKbRead({ note: 'contracts/overview', extra: true }, testContext)],
    [
      'promote',
      () =>
        handleKbPromote(
          {
            memo: 'memo-1',
            title: 'Title',
            content: 'Body',
            domain: 'eng',
            topic: 'routing',
            extra: true,
          },
          createKbSubsystem(),
          testContext,
        ),
    ],
    ['update', () => handleKbUpdate({ note: 'contracts/overview', title: 'Updated', extra: true }, createKbSubsystem())],
    ['delete', () => handleKbDelete({ note: 'contracts/overview', extra: true }, createKbSubsystem())],
    [
      'source-import',
      () =>
        handleKbSourceImport(
          {
            slug: 'bridge-removal-plan',
            stagedPath: '/tmp/bridge-removal-plan.md',
            meta: {
              title: 'Bridge Removal Plan',
              type: 'markdown',
              tags: ['plan', 'bridge'],
              importedAt: '2026-04-07T00:00:00.000Z',
              extra: true,
            },
          },
          createKbSubsystem(),
        ),
    ],
    ['source-list', () => handleKbSourceList({ extra: true }, createKbSubsystem())],
    ['source-delete', () => handleKbSourceDelete({ slug: 'bridge-removal-plan', extra: true }, createKbSubsystem())],
    ['reindex', () => handleKbReindex({ extra: true }, createKbSubsystem())],
    ['principles', () => handleKbPrinciples({ query: 'contract', extra: true }, createKbSubsystem())],
    ['memo', () => handleKbMemo({ topic: 'routing', content: 'memo', owner: 'owner-a', extra: true }, testContext)],
    ['memo-list', () => handleKbMemoList({ owner: 'owner-a', extra: true }, testContext)],
    ['memo-delete', () => handleKbMemoDelete({ pattern: '*', owner: 'owner-a', extra: true }, testContext)],
    ['memo-purge', () => handleKbMemoPurge({ owner: 'owner-a', extra: true }, testContext)],
  ])('rejects undeclared fields for %s', async (_name, run) => {
    expectInvalidRequest(await run());
  });

  it('uses search defaults after schema parsing', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.searchKb.mockResolvedValue({ hits: ['note:a'] });

    const result = await handleKbSearch({ query: 'contracts' }, kbSubsystem);

    expect(mockState.searchKb).toHaveBeenCalledWith(kbSubsystem.kb, 'contracts', 20, 'all');
    expect(result).toEqual({
      ok: true,
      data: { hits: ['note:a'] },
    });
  });

  it('accepts source-import meta while preserving the existing persistence call shape', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.persistPreparedSource.mockResolvedValue({
      slug: 'bridge-removal-plan',
      path: '/tmp/bridge-removal-plan.md',
    });

    const result = await handleKbSourceImport(
      {
        slug: 'bridge-removal-plan',
        stagedPath: '/tmp/bridge-removal-plan.md',
        meta: {
          title: 'Bridge Removal Plan',
          type: 'markdown',
          tags: ['plan', 'bridge'],
          importedAt: '2026-04-07T00:00:00.000Z',
        },
      },
      kbSubsystem,
    );

    expect(mockState.persistPreparedSource).toHaveBeenCalledWith(
      kbSubsystem.kb,
      '/tmp/bridge-removal-plan.md',
      'bridge-removal-plan',
    );
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      data: {
        slug: 'bridge-removal-plan',
        path: '/tmp/bridge-removal-plan.md',
      },
    });
  });

  it('still validates memo owners after Zod parsing', () => {
    const result = handleKbMemo(
      {
        topic: 'routing',
        content: 'memo',
        owner: 'invalid owner',
      },
      testContext,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });
});
