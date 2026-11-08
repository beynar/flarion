/** `account` procedures of the private contract: the signed-in person's own account (`auth/account-deletion.ts`). */
import { os, requireSession } from './base';
import { deleteAccount, ownedWorkspaces } from '../../auth/account-deletion';

export const accountHandlers = {
	delete: os.account.delete.use(requireSession).handler(async ({ context, input }) => {
		await deleteAccount(context, context.session, input.confirmEmail);
		return {};
	}),
	owned: os.account.owned.use(requireSession).handler(({ context }) => ownedWorkspaces(context.env, context.session.userId))
};
