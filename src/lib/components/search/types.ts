import type { Rpc } from '#lib/client/rpc.ts';

export type SearchHit = Awaited<ReturnType<Rpc['search']['query']>>['hits'][number];
