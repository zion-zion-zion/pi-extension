/**
 * Herdr 下自动展开 / 收起思维链。
 *
 * 没有官方 setHideThinkingBlock API，只能读 settings.json 里的布尔值，
 * 和目标不一致时用 `herdr pane send-keys <pane> ctrl+t` 翻转一次。
 *
 * 两个独立 hook，不计数、不记用户按键：
 *   agent_start   → 目标 false（展开，生成中能看见思考）
 *   agent_settled → 目标 true（收起，整轮含 follow-up 结束后藏起来）
 *
 * 已经是目标值则空操作。中途手按 Ctrl+T 保持到下一个 hook，再被扳回。
 *
 * 自动翻转会吞掉 pi 那行 `Thinking blocks: visible/hidden`（prototype 补丁）；
 * 手按 Ctrl+T 仍显示。只在 Herdr pane 的 TUI 里生效。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	InteractiveMode,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PANE_ID = process.env.HERDR_PANE_ID;
const ENABLED = process.env.HERDR_ENV === "1" && !!PANE_ID;
const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const SEND_TIMEOUT_MS = 2_000;
const WAIT_FOR_FILE_MS = 1_500;
const UNKNOWN_FILE_MS = 1_500;
const POLL_MS = 25;
const MUTE_MS = 1_500;
const THINKING_STATUS = /^Thinking blocks: (?:hidden|visible)$/;
const ORIGINAL_SHOW_STATUS = Symbol.for(
	"pi-extension.auto-hide-thinking.originalShowStatus",
);

type StatusHost = {
	showStatus?: (message: string) => void;
	[ORIGINAL_SHOW_STATUS]?: (message: string) => void;
};

let desiredHidden: boolean | undefined;
let pumping = false;
let muteCount = 0;
let muteTimer: ReturnType<typeof setTimeout> | undefined;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

/** 读不到或 JSON 坏了时返回 undefined，避免把半写入当成 false。 */
function readHideThinkingBlock(): boolean | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const value = (parsed as { hideThinkingBlock?: unknown }).hideThinkingBlock;
		if (value === undefined) return false;
		return value === true;
	} catch {
		return undefined;
	}
}

function shouldMuteThinkingStatus(message: string): boolean {
	if (muteCount <= 0 || !THINKING_STATUS.test(message)) return false;
	muteCount -= 1;
	return true;
}

function muteNextThinkingStatus(): void {
	muteCount += 1;
	if (muteTimer) clearTimeout(muteTimer);
	muteTimer = setTimeout(() => {
		muteCount = 0;
		muteTimer = undefined;
	}, MUTE_MS);
	muteTimer.unref?.();
}

function installShowStatusMute(): void {
	const proto = InteractiveMode.prototype as unknown as StatusHost;
	const stored = proto[ORIGINAL_SHOW_STATUS];
	const original = (typeof stored === "function" ? stored : proto.showStatus) as
		| ((message: string) => void)
		| undefined;
	if (typeof original !== "function") return;
	proto[ORIGINAL_SHOW_STATUS] = original;
	proto.showStatus = function (this: unknown, message: string) {
		if (shouldMuteThinkingStatus(message)) return;
		return original.call(this, message);
	};
}

async function waitUntilHidden(target: boolean, timeoutMs: number): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (readHideThinkingBlock() === target) return;
		await sleep(POLL_MS);
	}
}

async function sendCtrlT(pi: ExtensionAPI): Promise<boolean> {
	if (!PANE_ID) return false;
	try {
		const result = await pi.exec("herdr", ["pane", "send-keys", PANE_ID, "ctrl+t"], {
			timeout: SEND_TIMEOUT_MS,
		});
		return result.code === 0;
	} catch {
		return false;
	}
}

async function pump(pi: ExtensionAPI): Promise<void> {
	if (pumping) return;
	pumping = true;
	try {
		let unknownSince: number | undefined;
		while (desiredHidden !== undefined) {
			const target = desiredHidden;
			const current = readHideThinkingBlock();
			if (current === undefined) {
				unknownSince ??= Date.now();
				if (Date.now() - unknownSince > UNKNOWN_FILE_MS) {
					if (desiredHidden === target) desiredHidden = undefined;
					unknownSince = undefined;
					continue;
				}
				await sleep(POLL_MS);
				continue;
			}
			unknownSince = undefined;
			if (current === target) {
				if (desiredHidden === target) desiredHidden = undefined;
				continue;
			}
			// 静音必须在 send 之前：按键由 TUI 在 await 期间处理。
			muteNextThinkingStatus();
			const sent = await sendCtrlT(pi);
			if (!sent) {
				if (muteCount > 0) muteCount -= 1;
				if (desiredHidden === target) desiredHidden = undefined;
				continue;
			}
			if (desiredHidden === target) desiredHidden = undefined;
			await waitUntilHidden(target, WAIT_FOR_FILE_MS);
		}
	} finally {
		pumping = false;
		if (desiredHidden !== undefined) void pump(pi);
	}
}

function requestHidden(pi: ExtensionAPI, hidden: boolean): void {
	desiredHidden = hidden;
	void pump(pi);
}

export default function (pi: ExtensionAPI): void {
	if (!ENABLED) return;
	installShowStatusMute();
	pi.on("agent_start", (_event, ctx) => {
		if (!isTui(ctx)) return;
		requestHidden(pi, false);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!isTui(ctx)) return;
		requestHidden(pi, true);
	});
}
