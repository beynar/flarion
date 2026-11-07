import { WorkflowEntrypoint } from 'cloudflare:workers';

export class ImportWorkflow extends WorkflowEntrypoint<App.Platform['env']> {
	async run() {}
}
