export type ProviderKind = 'oev' | 'openai-compatible';
export interface ModelAlias {
	id: string;
	label: string;
	modelId: string;
	task: 'generation' | 'embedding';
}
export interface PublicProvider {
	id: string;
	label: string;
	kind: ProviderKind;
	baseUrl: string;
	apiKeyEnv: string;
	apiKeyConfigured: boolean;
	models: ModelAlias[];
	outputTokenParameter: 'max_completion_tokens' | 'max_tokens';
	structuredOutput: 'json_schema' | 'json_object';
}
export interface ProviderView { revision: number; providers: PublicProvider[] }
export interface ModelOption {
	value: string;
	label: string;
	providerId: string;
	providerLabel: string;
	modelId: string;
	decision: boolean;
}
