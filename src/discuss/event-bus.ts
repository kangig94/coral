export type DiscussEventBusEvents = {
  'discuss:updated': { projectRoot: string; sessionId: string; lastSeq: number; status: string };
};
