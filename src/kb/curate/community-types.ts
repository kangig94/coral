import type { AbstractGraph } from 'graphology-types';

type TagGraphNodeAttributes = Record<string, never>;
type TagGraphEdgeAttributes = { weight: number };

export type TagGraphEdge = {
  left: string;
  right: string;
  weight: number;
};

export type TagGraph = {
  graph: AbstractGraph<TagGraphNodeAttributes, TagGraphEdgeAttributes>;
  tags: string[];
  edges: TagGraphEdge[];
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

export type DetectedCommunity = {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
};

export type ExistingGeneratedCommunity = {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommunityDocument = {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
  content: string;
};
