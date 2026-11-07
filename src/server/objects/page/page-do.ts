import { DurableObject } from 'cloudflare:workers';

export class PageDO extends DurableObject<App.Platform['env']> {
	async ping() {
		return 'page';
	}
}
