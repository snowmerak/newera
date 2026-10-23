import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelSelection } from '$lib/theater/types';
import type { PublicProvider, ProviderView } from '$lib/providers/types';
import { record, text } from '$lib/theater/validation';

interface Provider extends Omit<PublicProvider, 'apiKeyConfigured'> { apiKey: string }
interface Registry { version: 1; revision: number; providers: Provider[] }
type Defaults = { baseUrl: string };
export interface ProviderRoute {
	providerId: string;
	providerLabel: string;
	kind: PublicProvider['kind'];
	baseUrl: string;
	model: string;
	apiKey: string;
	outputTokenParameter: PublicProvider['outputTokenParameter'];
	structuredOutput: PublicProvider['structuredOutput'];
}
/** Server-only, including credentials: never include these snapshots in page/API data or exports. */
export interface ProviderSnapshot { decision: ProviderRoute; text: ProviderRoute }
const accepted = new Map<string, Registry>();
const identifier = (value: unknown, name: string) => {
	const id = text(value, name, 80);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`${name} 형식이 올바르지 않습니다.`);
	return id;
};
const configPath = () => resolve(process.env.NEWERA_PROVIDER_CONFIG || resolve(process.env.NEWERA_DATA_DIR || 'data', 'providers.json'));

function provider(input: unknown): Provider {
	const row = record(input, 'Provider');
	const kind = row.kind;
	if (kind !== 'oev' && kind !== 'openai-compatible') throw new Error('Provider 유형이 올바르지 않습니다.');
	const url = new URL(text(row.baseUrl, 'Provider API 주소', 2000));
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 주소에는 http/https 주소를 쓰고 인증 정보·쿼리·해시는 제외해 주세요.');
	const apiKeyEnv = text(row.apiKeyEnv ?? '', 'API 키 환경 변수', 200, true);
	if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error('API 키 환경 변수 이름이 올바르지 않습니다.');
	if (!Array.isArray(row.models) || row.models.length > 100) throw new Error('모델 별칭은 최대 100개까지 등록할 수 있습니다.');
	const models: PublicProvider['models'] = row.models.map((entry) => {
		const model = record(entry, '모델 별칭');
		if (model.task !== 'generation' && model.task !== 'embedding') throw new Error('모델 용도가 올바르지 않습니다.');
		return { id: identifier(model.id, '별칭 ID'), label: text(model.label, '모델 별칭', 100), modelId: text(model.modelId, '실제 모델 ID', 200), task: model.task };
	});
	if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('모델 별칭 ID가 중복되었습니다.');
	const outputTokenParameter = row.outputTokenParameter ?? 'max_completion_tokens';
	const structuredOutput = row.structuredOutput ?? 'json_schema';
	if (outputTokenParameter !== 'max_tokens' && outputTokenParameter !== 'max_completion_tokens') throw new Error('출력 토큰 API 옵션이 올바르지 않습니다.');
	if (structuredOutput !== 'json_schema' && structuredOutput !== 'json_object') throw new Error('구조화된 출력 API 옵션이 올바르지 않습니다.');
	const apiKey = text(row.apiKey ?? '', 'API 키', 4000, true);
	if (/[\r\n]/.test(apiKey)) throw new Error('API 키에는 줄바꿈을 넣을 수 없습니다.');
	return { id: identifier(row.id, 'Provider ID'), label: text(row.label, 'Provider 이름', 100), kind, baseUrl: url.toString().replace(/\/+$/, ''), apiKeyEnv, apiKey, models, outputTokenParameter, structuredOutput };
}

export function providerRegistry(defaults: Defaults): Registry {
	const path = configPath();
	try {
		if (!existsSync(path)) return { version: 1, revision: 0, providers: [provider({ id: 'default', label: '기본 OEV', kind: 'oev', baseUrl: defaults.baseUrl, models: [] })] };
		const row = record(JSON.parse(readFileSync(path, 'utf8')), 'Provider 설정');
		if (row.version !== 1 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !Array.isArray(row.providers) || row.providers.length > 32) throw new Error('Provider 설정 파일 형식이 올바르지 않습니다.');
		const providers = row.providers.map(provider);
		if (!providers.some((entry) => entry.id === 'default' && entry.kind === 'oev') || new Set(providers.map((entry) => entry.id)).size !== providers.length) throw new Error('기본 OEV Provider가 없거나 ID가 중복되었습니다.');
		const registry: Registry = { version: 1, revision: Number(row.revision), providers };
		accepted.set(path, registry);
		return structuredClone(registry);
	} catch (error) {
		const previous = accepted.get(path);
		if (!previous) throw new Error('Provider 설정 파일을 읽을 수 없습니다. 주소와 설정 형식을 확인해 주세요.');
		console.warn('[Provider] 잘못된 설정 파일 대신 마지막 유효 설정을 유지합니다.');
		return structuredClone(previous);
	}
}

function publicView(registry: Registry): ProviderView {
	return { revision: registry.revision, providers: registry.providers.map(({ apiKey, ...entry }) => ({ ...entry, apiKeyConfigured: !!apiKey || !!entry.apiKeyEnv })) };
}
export function getProviders(defaults: Defaults): ProviderView { return publicView(providerRegistry(defaults)); }

function saveRegistry(registry: Registry): ProviderView {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
	accepted.set(path, structuredClone(registry));
	return publicView(registry);
}
export function saveProvider(defaults: Defaults, revision: number, input: unknown, clearApiKey = false): ProviderView {
	const registry = providerRegistry(defaults);
	if (registry.revision !== revision) throw new Error('Provider 설정이 변경되었습니다. 목록을 다시 불러와 주세요.');
	const row = record(input, 'Provider');
	const old = registry.providers.find((entry) => entry.id === row.id);
	const candidate = provider({ ...row, apiKey: clearApiKey ? '' : row.apiKey || old?.apiKey || '' });
	if (candidate.id === 'default' && candidate.kind !== 'oev') throw new Error('기본 Provider는 기존 typed decision을 위해 OEV로 유지해 주세요.');
	if (old) registry.providers[registry.providers.indexOf(old)] = candidate;
	else { if (registry.providers.length >= 32) throw new Error('Provider는 최대 32개까지 등록할 수 있습니다.'); registry.providers.push(candidate); }
	registry.revision++;
	return saveRegistry(registry);
}
export function deleteProvider(defaults: Defaults, revision: number, id: string): ProviderView {
	const registry = providerRegistry(defaults);
	if (registry.revision !== revision) throw new Error('Provider 설정이 변경되었습니다. 목록을 다시 불러와 주세요.');
	if (id === 'default') throw new Error('기본 OEV Provider는 삭제할 수 없습니다.');
	registry.providers = registry.providers.filter((entry) => entry.id !== id);
	registry.revision++;
	return saveRegistry(registry);
}

export const aliasReference = (providerId: string, aliasId: string) => `${providerId}::${aliasId}`;
function routeFor(owner: Provider, model: string): ProviderRoute {
	const apiKey = owner.apiKeyEnv ? process.env[owner.apiKeyEnv] : owner.apiKey;
	if (owner.apiKeyEnv && !apiKey) throw new Error(`${owner.label}: API 키 환경 변수가 설정되지 않았습니다.`);
	return { providerId: owner.id, providerLabel: owner.label, kind: owner.kind, baseUrl: owner.baseUrl, model, apiKey: apiKey ?? '', outputTokenParameter: owner.outputTokenParameter, structuredOutput: owner.structuredOutput };
}
export function providerCatalogRoute(defaults: Defaults, id: string): ProviderRoute {
	const owner = providerRegistry(defaults).providers.find((entry) => entry.id === id);
	if (!owner) throw new Error('조회할 Provider를 찾을 수 없습니다.');
	return routeFor(owner, '');
}
export function resolveProviderModel(defaults: Defaults, reference: string, task: 'decision' | 'generation' | 'embedding', registry = providerRegistry(defaults)): ProviderRoute {
	const parts = reference.split('::');
	const owner = registry.providers.find((entry) => entry.id === (parts.length === 1 ? 'default' : parts[0]));
	if (!owner || parts.length > 2) throw new Error('선택한 Provider가 없습니다. 모델 설정에서 다시 선택해 주세요.');
	const alias = parts.length === 2 ? owner.models.find((entry) => entry.id === parts[1]) : undefined;
	if (parts.length === 2 && !alias) throw new Error('선택한 모델 별칭이 없습니다. 모델 설정에서 다시 선택해 주세요.');
	if (alias && alias.task !== (task === 'embedding' ? 'embedding' : 'generation')) throw new Error('모델 별칭의 용도가 요청과 다릅니다.');
	if (task === 'decision' && owner.kind !== 'oev') throw new Error('판단 모델에는 /systemone을 지원하는 OEV Provider가 필요합니다.');
	return routeFor(owner, alias?.modelId ?? reference);
}
export function resolveProviderSnapshot(defaults: Defaults, selection: ModelSelection): ProviderSnapshot {
	const registry = providerRegistry(defaults);
	return { decision: resolveProviderModel(defaults, selection.decisionModel, 'decision', registry), text: resolveProviderModel(defaults, selection.textModel, 'generation', registry) };
}

export function checkedProviderSnapshot(input: unknown): ProviderSnapshot {
	const row = record(input, 'Provider 작업 스냅샷');
	const route = (input: unknown): ProviderRoute => {
		const value = record(input, 'Provider 호출 대상');
		const checked = provider({ ...value, id: value.providerId, label: value.providerLabel, models: [] });
		return { providerId: checked.id, providerLabel: checked.label, kind: checked.kind, baseUrl: checked.baseUrl, apiKey: checked.apiKey, model: text(value.model, '실제 모델 ID', 200), outputTokenParameter: checked.outputTokenParameter, structuredOutput: checked.structuredOutput };
	};
	const result = { decision: route(row.decision), text: route(row.text) };
	if (result.decision.kind !== 'oev') throw new Error('작업의 판단 Provider는 OEV여야 합니다.');
	return result;
}
