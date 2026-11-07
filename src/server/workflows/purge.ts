import { WorkflowEntrypoint } from 'cloudflare:workers';

export class PurgeWorkflow extends WorkflowEntrypoint<App.Platform['env']> {
	async run() {}
}
