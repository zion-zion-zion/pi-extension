/**
 * `/reload-all` —— 一条命令把 Herdr 里所有空闲的 pi 窗口重载一遍。
 *
 * 设计文档：docs/superpowers/specs/2026-09-14-reload-all-design.md
 *
 * 只向「agent_status === idle 且输入框为空」的其它 pane 注入 `/reload`；其余一律跳过并写进报告。
 * 之所以要检测输入框：`herdr pane run` 是把文本追加进目标窗口的编辑器再回车，若那里已有未提交的
 * 草稿，结果会变成「<草稿>/reload」被当普通消息发给模型 —— 宁可漏发，也不能污染别人的草稿。
 *
 * 报告的通道是 `pi.appendEntry()` + `pi.registerEntryRenderer()`，不是 `ctx.ui.notify()`。
 * 原因：`ctx.reload()` 会重建整个聊天区，瞬时 notify 会被一起清掉（实测确实如此，见设计文档
 * 「报告」一节）。custom entry 持久化在 session 里，且 `renderSessionEntries()` 对
 * `entry.type === "custom"` 有专门分支，因此扛得住自身 reload；notify 只留作瞬时提示。
 *
 * 标识用「工作区标签 / tab 标签」而非 `pane_id` 单打独斗：同一个 cwd 下常常挤着好几个 pane
 * （实测 investment 有 5 个），只看 cwd 分不清谁是谁。名字在写 entry 时就解析成最终字符串，
 * 渲染器因此不需要再调 herdr。
 *
 * 最后用 ctx.reload() 重载自己。文档要求把它当终止操作，之后不能再执行任何逻辑。
 */

import { basename } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { detectEditorState, type EditorState } from "./detect.ts";

const PANE_ID = process.env.HERDR_PANE_ID ?? "";
const ENABLED = process.env.HERDR_ENV === "1" && PANE_ID !== "";
const EXEC_TIMEOUT_MS = 2_000;
const ENTRY_TYPE = "reload-all-report";

type SkipReason = "busy" | "draft" | "unconfirmed";

const REASON_LABEL: Record<SkipReason, string> = {
	busy: "工作中",
	draft: "有未提交草稿",
	unconfirmed: "状态未确认",
};

type Pane = {
	paneId: string;
	agent: string;
	agentStatus: string;
	cwd: string;
	tabId: string;
	workspaceId: string;
};

/** 报告里每个 pane 都携带已解析好的显示名，渲染器无需再调 herdr。 */
type Named = { paneId: string; label: string };
type Failure = Named & { error: string };
type Skip = Named & { reason: SkipReason };

/**
 * 落进 session 的报告数据。
 *
 * 这个结构随版本变过：早期是裸字符串，中途是 `{ paneId, cwd, reason }`（无 label），现在是 `Named`。
 * session 里的历史 entry 不会因代码更新而重写，所以渲染器必须对三种形态都容错 —— 因此字段类型
 * 诚实地写为 `unknown[]`，而不是棿一个已经不准的联合类型。
 */
type ReportData = {
	at: string;
	sent: unknown[];
	failed: unknown[];
	skipped: unknown[];
};

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

async function execHerdr(pi: ExtensionAPI, args: string[]): Promise<string> {
	const result = await pi.exec("herdr", args, { timeout: EXEC_TIMEOUT_MS });
	if (result.code !== 0) {
		const detail = asString(result.stderr).trim() || asString(result.stdout).trim();
		throw new Error(`herdr ${args.join(" ")} 退出码 ${result.code}${detail ? `：${detail}` : ""}`);
	}
	return asString(result.stdout);
}

async function herdrJson(pi: ExtensionAPI, args: string[]): Promise<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(await execHerdr(pi, args));
	if (parsed && typeof parsed === "object" && "result" in parsed) {
		return ((parsed as { result: unknown }).result ?? {}) as Record<string, unknown>;
	}
	return (parsed ?? {}) as Record<string, unknown>;
}

async function listPanes(pi: ExtensionAPI): Promise<Pane[]> {
	const result = await herdrJson(pi, ["pane", "list"]);
	const raw = result.panes;
	if (!Array.isArray(raw)) throw new Error("herdr pane list 的返回里没有 panes 数组");
	return raw.map((entry) => {
		const pane = (entry ?? {}) as Record<string, unknown>;
		const cwd = asString(pane.cwd);
		return {
			paneId: asString(pane.pane_id),
			agent: asString(pane.agent),
			agentStatus: asString(pane.agent_status),
			cwd: cwd === "" ? "" : basename(cwd) || cwd,
			tabId: asString(pane.tab_id),
			workspaceId: asString(pane.workspace_id),
		};
	});
}

/**
 * 解析「工作区标签 / tab 标签」。这些标签只有 herdr 有：`pane list` 只给 id，
 * `terminal_title` 是从 cwd 推出来的（同一 cwd 下全都一样，无法区分）。
 * 纯属锦上添花 —— 取不到就回退到 cwd 的 basename，绝不让它拖垮整个命令。
 */
async function fetchLabels(
	pi: ExtensionAPI,
	panes: Pane[],
): Promise<Map<string, string>> {
	const labels = new Map<string, string>();
	const workspaceLabels = new Map<string, string>();
	const tabLabels = new Map<string, string>();

	try {
		const workspaceData = await herdrJson(pi, ["workspace", "list"]);
		for (const entry of (workspaceData.workspaces as unknown[]) ?? []) {
			const workspace = (entry ?? {}) as Record<string, unknown>;
			workspaceLabels.set(asString(workspace.workspace_id), asString(workspace.label));
		}
		for (const workspaceId of new Set(panes.map((pane) => pane.workspaceId).filter(Boolean))) {
			const tabData = await herdrJson(pi, ["tab", "list", "--workspace", workspaceId]);
			for (const entry of (tabData.tabs as unknown[]) ?? []) {
				const tab = (entry ?? {}) as Record<string, unknown>;
				tabLabels.set(asString(tab.tab_id), asString(tab.label));
			}
		}
	} catch {
		// 忽略：下面逐个回退到 cwd。
	}

	for (const pane of panes) {
		const workspace = workspaceLabels.get(pane.workspaceId) ?? "";
		const tab = tabLabels.get(pane.tabId) ?? "";
		let label: string;
		if (workspace && tab && tab !== workspace) label = `${workspace} / ${tab}`;
		else label = workspace || tab || pane.cwd;
		labels.set(pane.paneId, label);
	}
	return labels;
}

/** 读目标 pane 的可见屏幕，判断输入框是否为空。读不到一律按 unknown 处理（→ 跳过）。 */
async function readEditorState(pi: ExtensionAPI, paneId: string): Promise<EditorState> {
	try {
		const screen = await execHerdr(pi, [
			"pane",
			"read",
			paneId,
			"--source",
			"visible",
			"--format",
			"text",
		]);
		return detectEditorState(screen);
	} catch {
		return "unknown";
	}
}

function toRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "string") return { paneId: value };
	return (value ?? {}) as Record<string, unknown>;
}

/** 容错读出 `paneId` 与显示名；早期 entry 用的是 `cwd` 而不是 `label`。 */
function toNamed(value: unknown): Named {
	const item = toRecord(value);
	return {
		paneId: asString(item.paneId),
		label: asString(item.label) || asString(item.cwd),
	};
}

function toReason(value: unknown): SkipReason {
	const reason = asString(toRecord(value).reason);
	return reason === "busy" || reason === "draft" || reason === "unconfirmed" ? reason : "unconfirmed";
}

function row(paneId: string, label: string, tail: string, paneWidth: number, labelWidth: number): string {
	const head = `  ${paneId.padEnd(paneWidth)}`;
	return label === "" ? `${head}  ${tail}` : `${head}  ${label.padEnd(labelWidth)}  ${tail}`;
}

/** 报告正文（不含标题行）。纯函数，便于将来单测。 */
export function reportLines(data: ReportData): string[] {
	const sent = (data.sent ?? []).map(toNamed);
	const failed = (data.failed ?? []).map((value) => ({
		...toNamed(value),
		error: asString(toRecord(value).error),
	}));
	const skipped = (data.skipped ?? []).map((value) => ({
		...toNamed(value),
		reason: toReason(value),
	}));

	const head = [`已重载 ${sent.length}`];
	if (failed.length > 0) head.push(`发送失败 ${failed.length}`);
	if (skipped.length > 0) head.push(`跳过 ${skipped.length}`);

	// 全零时说清楚是“没找到”，否则“已重载 0”看不出是没找到还是全失败。
	if (sent.length === 0 && failed.length === 0 && skipped.length === 0) {
		return ["没有其它可重载的 pi 窗口"];
	}

	const entries = [
		...failed.map((failure) => ({
			paneId: failure.paneId,
			label: failure.label,
			tail: `❌ ${failure.error}`,
		})),
		...skipped.map((skip) => ({
			paneId: skip.paneId,
			label: skip.label,
			tail: `⏭️ ${REASON_LABEL[skip.reason]}`,
		})),
	];

	const paneWidth = Math.max(0, ...entries.map((entry) => entry.paneId.length));
	const labelWidth = Math.max(0, ...entries.map((entry) => entry.label.length));

	return [
		head.join(" · "),
		...entries.map((entry) => row(entry.paneId, entry.label, entry.tail, paneWidth, labelWidth)),
	];
}

function registerReportRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as ReportData;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.bold("/reload-all")}  ${theme.fg("dim", data.at ?? "")}`));
		for (const line of reportLines(data)) {
			box.addChild(new Text(line));
		}
		if (expanded) {
			const sent = (data.sent ?? []).map(toNamed);
			if (sent.length > 0) {
				const names = sent.map((item) => item.label || item.paneId).join("、");
				box.addChild(new Text(theme.fg("dim", `已重载：${names}`)));
			}
		}
		return box;
	});
}

async function reloadAll(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ENABLED) {
		ctx.ui.notify("/reload-all 只在 Herdr 里可用（HERDR_ENV !== 1），未做任何操作。", "error");
		return;
	}

	let panes: Pane[];
	try {
		panes = await listPanes(pi);
	} catch (error) {
		// 没做成任何事，且不会 reload 自己 —— notify 不会被清掉，无需落盘。
		ctx.ui.notify(`/reload-all 失败：读取 pane 列表出错 —— ${errText(error)}。未做任何操作。`, "error");
		return;
	}

	const targets: Pane[] = [];
	const skipped: Skip[] = [];

	for (const pane of panes) {
		if (pane.agent !== "pi" || pane.paneId === "" || pane.paneId === PANE_ID) continue;
		if (pane.agentStatus !== "idle") {
			skipped.push({ paneId: pane.paneId, label: "", reason: "busy" });
			continue;
		}
		const state = await readEditorState(pi, pane.paneId);
		if (state === "empty") {
			targets.push(pane);
		} else {
			skipped.push({
				paneId: pane.paneId,
				label: "",
				reason: state === "occupied" ? "draft" : "unconfirmed",
			});
		}
	}

	const settled = await Promise.all(
		targets.map(async (pane) => {
			try {
				await execHerdr(pi, ["pane", "run", pane.paneId, "/reload"]);
				return { pane, ok: true as const, error: "" };
			} catch (error) {
				return { pane, ok: false as const, error: errText(error) };
			}
		}),
	);

	// 名字只在这里解析一次，写进 entry 的最终字符串里。
	const involved = [...targets, ...skipped.map((skip) => panes.find((p) => p.paneId === skip.paneId) ?? null)]
		.filter((pane): pane is Pane => pane !== null);
	const labels = await fetchLabels(pi, involved);
	const labelOf = (paneId: string, fallback: string) => labels.get(paneId) || fallback;

	const sent: Named[] = settled
		.filter((item) => item.ok)
		.map((item) => ({ paneId: item.pane.paneId, label: labelOf(item.pane.paneId, item.pane.cwd) }));
	const failed: Failure[] = settled
		.filter((item) => !item.ok)
		.map((item) => ({
			paneId: item.pane.paneId,
			label: labelOf(item.pane.paneId, item.pane.cwd),
			error: item.error,
		}));
	const skippedNamed: Skip[] = skipped.map((skip) => ({
		...skip,
		label: labelOf(skip.paneId, ""),
	}));

	// 落盘的完整报告：这份才扛得住下面那次 ctx.reload()。
	pi.appendEntry(ENTRY_TYPE, {
		at: stamp(),
		sent,
		failed,
		skipped: skippedNamed,
	} satisfies ReportData);

	const summary = [`已重载 ${sent.length}`];
	if (failed.length > 0) summary.push(`失败 ${failed.length}`);
	if (skippedNamed.length > 0) summary.push(`跳过 ${skippedNamed.length}`);
	ctx.ui.notify(`/reload-all：${summary.join(" · ")}（报告见上方）`, failed.length > 0 ? "error" : "info");

	// 终止操作：reload 之后本模块的执行环境即被卸载，不能再做任何事。
	await ctx.reload();
	return;
}

export default function (pi: ExtensionAPI): void {
	registerReportRenderer(pi);
	pi.registerCommand("reload-all", {
		description: "重载 Herdr 里所有空闲的 pi 窗口（跳过忙碌或输入框里有草稿的）",
		handler: async (_args, ctx) => {
			await reloadAll(pi, ctx);
		},
	});
}
