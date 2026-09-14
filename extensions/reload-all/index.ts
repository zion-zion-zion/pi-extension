/**
 * `/reload-all` —— 一条命令把 Herdr 里所有空闲的 pi 窗口重载一遍。
 *
 * 设计文档：docs/superpowers/specs/2026-09-14-reload-all-design.md
 *
 * 只向「agent_status === idle 且输入框为空」的其它 pane 注入 `/reload`；其余一律跳过并写进报告。
 * 之所以要检测输入框：`herdr pane run` 是把文本追加进目标窗口的编辑器再回车，若那里已有未提交的
 * 草稿，结果会变成「<草稿>/reload」被当普通消息发给模型 —— 宁可漏发，也不能污染别人的草稿。
 *
 * 最后用 ctx.reload() 重载自己。文档要求把它当终止操作，之后不能再执行任何逻辑。
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { detectEditorState, type EditorState } from "./detect.ts";

const PANE_ID = process.env.HERDR_PANE_ID ?? "";
const ENABLED = process.env.HERDR_ENV === "1" && PANE_ID !== "";
const EXEC_TIMEOUT_MS = 2_000;
const MAX_REPORT_CHARS = 500;

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
};

type Skip = { paneId: string; reason: SkipReason; cwd: string };

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function execHerdr(pi: ExtensionAPI, args: string[]): Promise<string> {
	const result = await pi.exec("herdr", args, { timeout: EXEC_TIMEOUT_MS });
	if (result.code !== 0) {
		const detail = asString(result.stderr).trim() || asString(result.stdout).trim();
		throw new Error(`herdr ${args.join(" ")} 退出码 ${result.code}${detail ? `：${detail}` : ""}`);
	}
	return asString(result.stdout);
}

async function listPanes(pi: ExtensionAPI): Promise<Pane[]> {
	const parsed: unknown = JSON.parse(await execHerdr(pi, ["pane", "list"]));
	const result =
		parsed && typeof parsed === "object" && "result" in parsed
			? (parsed as { result: unknown }).result
			: parsed;
	const raw = (result as { panes?: unknown } | null)?.panes;
	if (!Array.isArray(raw)) throw new Error("herdr pane list 的返回里没有 panes 数组");
	return raw.map((entry) => {
		const pane = (entry ?? {}) as Record<string, unknown>;
		const cwd = asString(pane.cwd);
		return {
			paneId: asString(pane.pane_id),
			agent: asString(pane.agent),
			agentStatus: asString(pane.agent_status),
			cwd: cwd === "" ? "" : basename(cwd) || cwd,
		};
	});
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

function buildReport(
	sent: string[],
	failed: { paneId: string; error: string }[],
	skipped: Skip[],
): string {
	const parts: string[] = [];
	if (sent.length > 0) parts.push(`已重载 ${sent.length}`);
	if (failed.length > 0) {
		parts.push(`发送失败 ${failed.length}（${failed.map((f) => `${f.paneId} ${f.error}`).join(" · ")}）`);
	}
	if (skipped.length > 0) {
		const detail = skipped
			.map((s) => `${s.paneId} ${REASON_LABEL[s.reason]}${s.cwd ? `·${s.cwd}` : ""}`)
			.join(" · ");
		parts.push(`跳过 ${skipped.length}（${detail}）`);
	}
	const body = parts.length === 0 ? "没有其它 pi 窗口" : parts.join(" | ");
	const report = `/reload-all：${body}`;
	return report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS - 1)}…` : report;
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
		ctx.ui.notify(`/reload-all 失败：读取 pane 列表出错 —— ${errText(error)}。未做任何操作。`, "error");
		return;
	}

	const targets: Pane[] = [];
	const skipped: Skip[] = [];

	for (const pane of panes) {
		if (pane.agent !== "pi" || pane.paneId === "" || pane.paneId === PANE_ID) continue;
		if (pane.agentStatus !== "idle") {
			skipped.push({ paneId: pane.paneId, reason: "busy", cwd: pane.cwd });
			continue;
		}
		const state = await readEditorState(pi, pane.paneId);
		if (state === "empty") {
			targets.push(pane);
		} else {
			skipped.push({
				paneId: pane.paneId,
				reason: state === "occupied" ? "draft" : "unconfirmed",
				cwd: pane.cwd,
			});
		}
	}

	const settled = await Promise.all(
		targets.map(async (pane) => {
			try {
				await execHerdr(pi, ["pane", "run", pane.paneId, "/reload"]);
				return { paneId: pane.paneId, ok: true as const, error: "" };
			} catch (error) {
				return { paneId: pane.paneId, ok: false as const, error: errText(error) };
			}
		}),
	);

	const sent = settled.filter((s) => s.ok).map((s) => s.paneId);
	const failed = settled
		.filter((s) => !s.ok)
		.map((s) => ({ paneId: s.paneId, error: s.error }));
	const anyFailed = failed.length > 0;

	ctx.ui.notify(buildReport(sent, failed, skipped), anyFailed ? "error" : "info");

	// 终止操作：reload 之后本模块的执行环境即被卸载，不能再做任何事。
	await ctx.reload();
	return;
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("reload-all", {
		description: "重载 Herdr 里所有空闲的 pi 窗口（跳过忙碌或输入框里有草稿的）",
		handler: async (_args, ctx) => {
			await reloadAll(pi, ctx);
		},
	});
}
