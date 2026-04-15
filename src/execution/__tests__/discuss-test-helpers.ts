import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { resolveProjectSource, sourceToSlug } from '../../infra/paths.js';
import type {
  DiscussDomainEvent,
  PersistedDiscussSnapshot,
  SessionCreatedAgentExecutionConfig,
} from '../../discuss/events.js';
import { decideSessionCreate } from '../../discuss/state-machine.js';
import type { DiscussCreateInput } from '../../discuss/types.js';
import {
  createDiscussContextRegistry,
  getOrCreate as getOrCreateDiscussContext,
  type DiscussContextRegistry,
} from '../discuss/context-registry.js';
import type { DiscussContext } from '../discuss/context.js';
import { buildWatchEvents } from '../../discuss/projections.js';
import { DiscussSessionStore } from '../discuss/session-store.js';
import { attachSession, detachSession, listSessions } from '../discuss/registry.js';
import { isAbortEnded, readSessionEvents } from '../discuss/persistence.js';
import type { CallerContext } from '../../shared/request-context.js';
import type { ExecutionService } from '../service.js';
import { createRealRuntime } from '../runtime.js';

export const DEFAULT_TOPIC = 'Should the city pedestrianize the downtown core?';
export const DEFAULT_TS = '2026-03-10T00:00:00.000Z';

export function defaultAgents(): Array<DiscussCreateInput['agents'][number]> {
  return [
    { name: 'alpha', persona: '# Alpha', participation: 'required' },
    { name: 'beta', persona: '# Beta', participation: 'required' },
  ];
}

export function defaultAgentExecution(
  agents: Array<DiscussCreateInput['agents'][number]>,
): Record<string, SessionCreatedAgentExecutionConfig> {
  return Object.fromEntries(
    agents.map((agent): [string, SessionCreatedAgentExecutionConfig] => {
      if (agent.participation === 'observer' && agent.name === 'user') {
        return [agent.name, { manual: true }];
      }
      return [
        agent.name,
        {
          manual: false,
          provider: 'codex',
          model: 'gpt-5',
        },
      ];
    }),
  );
}

export function createExecutionServiceStub(overrides: Partial<ExecutionService> = {}): ExecutionService {
  return {
    start: vi.fn(),
    resume: vi.fn(),
    fork: vi.fn(),
    coralDispatch: vi.fn(),
    executeWorkflow: vi.fn(),
    list: vi.fn(() => ({ sessions: [] })),
    abort: vi.fn(() => ({ aborted: [], notFound: [] })),
    waitStream: vi.fn(async function* () {}),
    waitStreamOnce: vi.fn(),
    ...overrides,
  } as unknown as ExecutionService;
}

export type DiscussHarness = {
  tmpRoot: string;
  projectRoot: string;
  ctx: CallerContext;
  store: DiscussSessionStore;
  context: DiscussContext;
  registry: DiscussContextRegistry;
  service: ExecutionService;
  cleanup: () => void;
};

const activeHarnesses = new Set<DiscussHarness>();
const discussTestHomeRoot = mkdtempSync(join(tmpdir(), 'coral-discuss-home-'));
const originalHome = process.env.HOME;
let usingDiscussTestHome = false;

function cleanupLiveSessions(context: DiscussContext): void {
  for (const [sessionId, session] of listSessions(context)) {
    session.controller.abort();
    detachSession(context, sessionId);
  }
}

function enableDiscussTestHome(): void {
  if (usingDiscussTestHome) {
    return;
  }
  process.env.HOME = discussTestHomeRoot;
  mkdirSync(join(discussTestHomeRoot, '.coral'), { recursive: true });
  usingDiscussTestHome = true;
}

function disableDiscussTestHome(): void {
  if (!usingDiscussTestHome || activeHarnesses.size > 0) {
    return;
  }
  // Restore HOME before cleanup so rmSync targets are deterministic
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(discussTestHomeRoot, { recursive: true, force: true });
  usingDiscussTestHome = false;
}

let harnessCounter = 0;

export function createDiscussHarness(service = createExecutionServiceStub(), sourceOverride?: string): DiscussHarness {
  enableDiscussTestHome();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'coral-discuss-'));
  const projectRoot = join(tmpRoot, `project-${++harnessCounter}`);
  const pluginRoot = join(tmpRoot, 'plugin');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });

  const source = sourceOverride ?? resolveProjectSource(projectRoot);
  const runtime = createRealRuntime();
  const store = new DiscussSessionStore(source, {
    storage: runtime.storage,
    time: runtime.time,
    paths: runtime.paths,
  });
  const registry = createDiscussContextRegistry();
  const context = getOrCreateDiscussContext(registry, projectRoot, service, store);
  const ctx: CallerContext = { projectRoot, pluginRoot, coralEnv: {} };
  let cleaned = false;

  const harness: DiscussHarness = {
    tmpRoot,
    projectRoot,
    ctx,
    store,
    context,
    registry,
    service,
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      store.dispose();
      cleanupLiveSessions(context);
      rmSync(tmpRoot, { recursive: true, force: true });
      // Clean project data dir under both fake and real home (threads pool HOME pollution)
      const slug = sourceToSlug(source);
      rmSync(join(discussTestHomeRoot, '.coral', 'projects', slug), { recursive: true, force: true });
      if (originalHome) {
        rmSync(join(originalHome, '.coral', 'projects', slug), { recursive: true, force: true });
      }
      activeHarnesses.delete(harness);
      disableDiscussTestHome();
    },
  };
  activeHarnesses.add(harness);

  return harness;
}

export function cleanupDiscussHarnesses(): void {
  for (const harness of [...activeHarnesses]) {
    harness.cleanup();
  }
  disableDiscussTestHome();
}

export function attachPersistedSession(
  harness: Pick<DiscussHarness, 'context'>,
  snapshot: PersistedDiscussSnapshot,
): void {
  const events = readSessionEvents(harness.context, snapshot.sessionId);
  attachSession(
    harness.context,
    snapshot,
    {
      baseCursor: 0,
      events: buildWatchEvents(events),
    },
    isAbortEnded(events),
  );
}

export async function persistSession(
  harness: DiscussHarness,
  options: {
    sessionId?: string;
    topic?: string;
    agents?: Array<DiscussCreateInput['agents'][number]>;
    minBidDelayMs?: number;
    createdAt?: string;
    agentExecution?: Record<string, SessionCreatedAgentExecutionConfig>;
    buildTail?: (snapshot: PersistedDiscussSnapshot) => DiscussDomainEvent[];
    recover?: boolean;
  } = {},
): Promise<PersistedDiscussSnapshot> {
  const sessionId = options.sessionId ?? 'discuss-1';
  const topic = options.topic ?? DEFAULT_TOPIC;
  const agents = options.agents ?? defaultAgents();
  const createdAt = options.createdAt ?? DEFAULT_TS;
  const input: DiscussCreateInput = {
    topic,
    agents,
    min_bid_delay_ms: options.minBidDelayMs ?? 0,
  };
  const created = decideSessionCreate(input, sessionId, harness.projectRoot, topic, 1, createdAt, {
    agentExecution: options.agentExecution ?? defaultAgentExecution(agents),
  });
  if (!created.ok) {
    const createError = created.error;
    throw new Error(createError);
  }

  let snapshot = await harness.store.append(sessionId, null, created.value);
  if (options.buildTail) {
    const tailEvents = options.buildTail(snapshot);
    if (tailEvents.length > 0) {
      snapshot = await harness.store.append(sessionId, snapshot.lastAppliedSeq, tailEvents);
    }
  }

  harness.store.flushDirtyIndexes();

  if (options.recover ?? false) {
    const attached = harness.store.load(sessionId) ?? snapshot;
    attachPersistedSession(harness, attached);
  }

  return harness.store.load(sessionId) ?? snapshot;
}

export async function appendPersistedEvents(
  harness: DiscussHarness,
  sessionId: string,
  buildTail: (snapshot: PersistedDiscussSnapshot) => DiscussDomainEvent[],
): Promise<PersistedDiscussSnapshot> {
  const snapshot = harness.store.load(sessionId);
  if (!snapshot) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const events = buildTail(snapshot);
  if (events.length === 0) {
    return snapshot;
  }

  const result = await harness.store.append(sessionId, snapshot.lastAppliedSeq, events);
  harness.store.flushDirtyIndexes();
  return result;
}
