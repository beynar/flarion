/**
 * Vectorize seam (owner: Accounts, AI, API). Chunks are `pageId:chunk` with `workspaceId`/`pageId`
 * metadata. Optional binding: no-ops when `env.VECTORS` is absent (dev).
 */
export async function deletePageVectors(_env: Env, _workspaceId: string, _pageIds: string[]): Promise<void> {}
