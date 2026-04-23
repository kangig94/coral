import type { DiscussState } from '../discuss/session-types.js';

export interface DiscussDiscoverySession {
  sessionId: string;
  topic: string;
  sessionDir: string;
  createdAt: string;
}

export interface DiscussDiscoveryData {
  sessions: DiscussDiscoverySession[];
  source: string;
  updatedAt: string;
}

export interface DiscussSummaryIndexRow {
  sessionId: string;
  projectRoot: string;
  topic: string;
  status: DiscussState['status'];
  createdAt: string;
  agentCount: number;
  updatedAt: string;
  lastSeq: number;
}

export interface DiscussSummaryIndexData {
  sessions: DiscussSummaryIndexRow[];
  source: string;
  updatedAt: string;
}
