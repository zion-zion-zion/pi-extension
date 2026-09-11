/**
 * 模型列表过滤器：隐藏内置 provider 里用不到的历史模型。
 *
 * 背景：pi 内置 provider 的模型列表写死在程序里，`models.json` 只能覆盖 / 追加、
 * 不能删除；`models-store.json` 的远端目录也只是「合并」到内置列表上。所以想
 * 真正去掉某个内置模型，只能通过扩展替换 provider。
 *
 * 做法：在扩展加载阶段（早于 `/model`、`--list-models` 读取模型）用官方导出的
 * `builtinProviders()` 取得内置 provider，挂上 `filterModels` 过滤掉指定模型。
 * `filterModels` 只影响「可用模型列表」，OAuth / 鉴权 / 请求实现全部沿用内置。
 *
 * 注意：这会用静态内置目录替换 pi 通过 `models-store.json` 做的远端目录叠加，
 * 也就是说以后 pi 只升级模型目录（不升级 pi 本体）时新增的模型不会自动出现；
 * 升级 pi 后会自动带上。对当前 openai-codex 无影响（远端目录没有新增项）。
 *
 * 配置：按 provider 写要隐藏的模型 id，`*` 结尾表示前缀匹配。
 * 新增模型默认保留，只有明确列出的才会隐藏。
 */

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** provider id -> 要隐藏的模型 id 列表。`*` 结尾表示前缀匹配。 */
const HIDDEN_MODELS: Record<string, string[]> = {
	"openai-codex": ["gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"],
};

function isHidden(modelId: string, patterns: string[]): boolean {
	return patterns.some((pattern) =>
		pattern.endsWith("*") ? modelId.startsWith(pattern.slice(0, -1)) : modelId === pattern,
	);
}

function withHiddenModels(provider: Provider, hidden: string[]): Provider {
	const previous = provider.filterModels?.bind(provider);
	return {
		...provider,
		filterModels: (models, credential) => {
			const base = previous ? previous(models, credential) : models;
			return base.filter((model) => !isHidden(model.id, hidden));
		},
	};
}

export default function (pi: ExtensionAPI): void {
	const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));

	for (const [providerId, hidden] of Object.entries(HIDDEN_MODELS)) {
		if (hidden.length === 0) continue;
		const provider = builtins.get(providerId);
		if (!provider) {
			console.error(`[model-filter] 未找到内置 provider: ${providerId}`);
			continue;
		}
		pi.registerProvider(withHiddenModels(provider, hidden));
	}
}
