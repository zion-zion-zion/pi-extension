/**
 * footer 上的模型名。
 *
 * pi-footer 的 Model 组件只渲染 model.id，Provider/Model 再在前面拼上 provider，
 * 都没有改名的地方。这里把显示名发到 Event Value widget（Widget ID = model_label）：
 *   1. 下面的 ALIASES 优先，按 "provider/id" 精确匹配；
 *   2. 没有别名就用 models.json 里的 name，并去掉来源后缀（" · routing group" 这类）；
 *   3. 连 name 都没有，退回 model.id。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "model_label";
const UPDATE_CHANNEL = "pi-footer:update-widget";

/**
 * 想改某个模型在 footer 上的名字，加一行。键是 "provider/model.id"。
 * 不写的模型走 models.json 的 name。
 */
const ALIASES: Record<string, string> = {
	"magpie/codex/gpt-6.1-sol": "奥特曼",
	"magpie/codex/gpt-6.1-terra": "O畜",
	"magpie/aigw/gpt-6.1-sol": "盗版O社",
	"magpie/aigw/deepseek-flash": "梁圣",
	"magpie/aigw/grok-4.7": "宝马",
	"magpie/aigw/k3.1-pro-highspeed": "月亮之上",
	"magpie/01ai-tokenhub/grok-4.7-build-fast": "汗血宝马",
};

/** models.json 的 name 用 " · " 挂上来源，footer 上不需要。 */
const SOURCE_SUFFIX = /\s+[·|]\s+.+$/;

export function modelLabel(model: { provider?: string; id?: string; name?: string } | undefined | null): string | null {
	if (!model?.id) return null;
	const alias = model.provider ? ALIASES[`${model.provider}/${model.id}`] : undefined;
	if (alias) return alias;
	const name = model.name?.trim();
	if (name) return name.replace(SOURCE_SUFFIX, "");
	return model.id;
}

export default function (pi: ExtensionAPI) {
	let last: string | null = null;

	const publish = (value: string | null) => {
		if (value === last) return;
		last = value;
		pi.events.emit(UPDATE_CHANNEL, { widgetId: WIDGET_ID, value });
	};

	const refresh = (ctx: { model?: { provider?: string; id?: string; name?: string } | null }) => {
		publish(modelLabel(ctx.model));
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("model_select", (_event, ctx) => refresh(ctx));
}
