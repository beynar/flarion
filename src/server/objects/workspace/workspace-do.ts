import { DurableObject } from 'cloudflare:workers';

export class WorkspaceDO extends DurableObject<App.Platform['env']> {
	async ping() {
		return 'workspace';
	}
}
