/** `files` procedures of the private contract. Owner: Editor and files (P2). Replace stubs with real handlers. */
import { notImplemented, os } from './base';

export const filesHandlers = {
	begin: os.files.begin.handler(() => notImplemented('files.begin')),
	complete: os.files.complete.handler(() => notImplemented('files.complete')),
	abort: os.files.abort.handler(() => notImplemented('files.abort')),
	get: os.files.get.handler(() => notImplemented('files.get')),
};
