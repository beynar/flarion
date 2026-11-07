// Minimal copy of viborm's tests/contracts/contract.ts: only `defineContract`, which the behaviors use.
export interface ContractDefinition<TFixture> {
	readonly id: string;
	readonly owningLayer: string;
	readonly tier: 'core' | 'extended';
	readonly requiredCapabilities: readonly string[];
	readonly register: (fixture: TFixture) => void;
}

export function defineContract<const TDefinition extends ContractDefinition<never>>(
	definition: TDefinition
): TDefinition {
	return definition;
}
