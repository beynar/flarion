import type { RouteHandler } from './types';

export const handlePublicApi: RouteHandler = async () => new Response('Not implemented', { status: 501 });
