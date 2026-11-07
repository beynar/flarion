import type { RouteHandler } from './types';

export const handleRpc: RouteHandler = async () => new Response('Not implemented', { status: 501 });
