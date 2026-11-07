import { WorkflowEntrypoint } from 'cloudflare:workers';

export class ExportWorkflow extends WorkflowEntrypoint<App.Platform['env']> {
	async run() {}
}
