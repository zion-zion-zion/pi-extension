/**
 * `/reload-all` 与 `/restart-all` 共用的「哪些窗口能动」判据。
 *
 * 刻意做成纯函数、不 import pi / herdr：这样可以在 `plan.test.ts` 里直接单测
 * （`index.ts` 会 import `@earendil-works/pi-tui`，测试环境解析不到，无法直接测它）。
 *
 * 设计文档：docs/superpowers/specs/2026-09-14-restart-design.md
 */

import type { EditorState } from "./detect.ts";

export type SkipReason = "busy" | "draft" | "unconfirmed" | "no-session";

export const REASON_LABEL: Record<SkipReason, string> = {
	busy: "工作中",
	draft: "有未提交草稿",
	unconfirmed: "状态未确认",
	"no-session": "Herdr 里没有会话记录",
};

const SKIP_REASONS = Object.keys(REASON_LABEL) as SkipReason[];

export function isSkipReason(value: string): value is SkipReason {
	return (SKIP_REASONS as string[]).includes(value);
}

/** 从 `herdr pane list` 解析出来的窗口。 */
export type Pane = {
	paneId: string;
	agent: string;
	agentStatus: string;
	/** cwd 的 basename，报告里当兜底名字用。 */
	cwd: string;
	tabId: string;
	workspaceId: string;
	/** `agent_session.value`：pi 的会话文件路径（也可能是会话 id，两者 `pi --session` 都收）。 */
	sessionRef: string;
};

export type PaneVerdict =
	/** 不是 pi / 没有 pane id / 就是自己：连报告都不进。 */
	| { kind: "ignore" }
	/** 前置条件都过了，但还没读输入框 —— 调用方补一次 `readEditorState` 再判。 */
	| { kind: "need-editor" }
	| { kind: "target" }
	| { kind: "skip"; reason: SkipReason };

/**
 * 单个窗口该不该动。
 *
 * `editorState` 传 `"unread"` 表示还没读屏幕；顺序上便宜的判断在前 ——
 * 忙碌、以及（`/restart-all` 下的）没有会话记录的窗口，都不必再花一次 `herdr pane read`。
 *
 * `requireSession` = 这次操作能不能在「没有会话记录」时继续：
 * `/reload-all` 不关心会话（false），`/restart-all` 必须能恢复同一个对话（true）。
 */
export function classifyPane(
	pane: Pane,
	selfPaneId: string,
	requireSession: boolean,
	editorState: EditorState | "unread",
): PaneVerdict {
	if (pane.agent !== "pi" || pane.paneId === "" || pane.paneId === selfPaneId) {
		return { kind: "ignore" };
	}
	if (pane.agentStatus !== "idle") return { kind: "skip", reason: "busy" };
	if (requireSession && pane.sessionRef === "") return { kind: "skip", reason: "no-session" };
	if (editorState === "unread") return { kind: "need-editor" };
	if (editorState === "empty") return { kind: "target" };
	return { kind: "skip", reason: editorState === "occupied" ? "draft" : "unconfirmed" };
}
