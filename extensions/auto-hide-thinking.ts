/**
 * Herdr 下按 Ctrl+T 联动显示 / 隐藏思考过程和工具输出。
 *
 * 没有官方 setHideThinkingBlock API，只能读 settings.json 里的布尔值，
 * 和目标不一致时用 `herdr pane send-keys <pane> ctrl+t` 翻转一次。
 *
 * 两个独立 hook，不计数、不记用户按键：
 *   agent_start   → 目标 false（展开，生成中能看见思考）
 *   agent_settled → 目标 true（收起，整轮含 follow-up 结束后藏起来）
 *
 * 思考隐藏时，工具组件的 render 返回空数组，因此 Bash、Read、Edit 等工具块
 * 完全不显示；恢复思考时调用原 render，保留 pi 原有的预览 / 展开状态。
 * 已经是目标值则空操作。中途手按 Ctrl+T 保持到下一个 hook，再被扳回。
 *
 * 自动翻转会吞掉 pi 那行 `Thinking blocks: visible/hidden`（prototype 补丁）；
 * 手按 Ctrl+T 仍显示原生提示。只在 Herdr pane 的 TUI 里生效。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BashExecutionComponent,
	getAgentDir,
	InteractiveMode,
	ToolExecutionComponent,
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

const PATCH_STATE = Symbol.for("pi-extension.auto-hide-thinking.patchState");

type ThinkingHost = {
	hideThinkingBlock?: boolean;
	ui?: {
		requestRender?: () => void;
	};
	toggleThinkingBlockVisibility?: () => void;
	updateThinkingBlockVisibility?: () => void;
	showStatus?: (message: string) => void;
};

type RenderHost = {
	render?: (width: number) => string[];
};

type PatchState = {
	enabled: boolean;
	generation: number;
	/** undefined means that no trustworthy visibility state has been observed yet. */
	processVisible: boolean | undefined;
	activeMode?: ThinkingHost;
	muteCount: number;
	desiredHidden?: boolean;
	requestId: number;
	activePump?: {
		generation: number;
		requestId: number;
		controller: AbortController;
	};
	muteTimer?: ReturnType<typeof setTimeout>;
	originalShowStatus?: (message: string) => void;
	originalToggleThinking?: () => void;
	originalUpdateThinking?: () => void;
	originalToolRender?: (width: number) => string[];
	originalBashRender?: (width: number) => string[];
	showStatusWrapper?: (message: string) => void;
	toggleThinkingWrapper?: () => void;
	updateThinkingWrapper?: () => void;
	toolRenderWrapper?: (width: number) => string[];
	bashRenderWrapper?: (width: number) => string[];
};

type PatchedInteractivePrototype = ThinkingHost & {
	[PATCH_STATE]?: PatchState;
};

let currentPatchState: PatchState | undefined;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
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
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

function clearMute(state: PatchState): void {
	state.muteCount = 0;
	if (state.muteTimer) {
		clearTimeout(state.muteTimer);
		state.muteTimer = undefined;
	}
}

function shouldMuteThinkingStatus(state: PatchState, message: string): boolean {
	if (!state.enabled || state.muteCount <= 0 || !THINKING_STATUS.test(message)) return false;
	state.muteCount -= 1;
	return true;
}

function muteNextThinkingStatus(state: PatchState): void {
	state.muteCount += 1;
	if (state.muteTimer) clearTimeout(state.muteTimer);
	state.muteTimer = setTimeout(() => {
		state.muteCount = 0;
		state.muteTimer = undefined;
	}, MUTE_MS);
	state.muteTimer.unref?.();
}

function setProcessVisible(state: PatchState, visible: boolean, requestRender = false): void {
	if (!state.enabled) return;
	state.processVisible = visible;
	if (requestRender) state.activeMode?.ui?.requestRender?.();
}

function installPatches(): PatchState | undefined {
	if (!ENABLED) return undefined;

	const proto = InteractiveMode.prototype as unknown as PatchedInteractivePrototype;
	let state = proto[PATCH_STATE];
	if (!state) {
		state = {
			enabled: false,
			generation: 0,
			processVisible: undefined,
			muteCount: 0,
			requestId: 0,
		};
		proto[PATCH_STATE] = state;
	}

	// A normal /reload restores the old wrappers during session_shutdown. This
	// branch also handles a reload implementation that leaves the wrappers in place.
	if (state.enabled) return state;
	state.enabled = true;
	state.generation += 1;
	state.activeMode = undefined;
	state.desiredHidden = undefined;
	state.requestId += 1;
	state.activePump?.controller.abort();
	state.activePump = undefined;
	clearMute(state);

	const configuredHidden = readHideThinkingBlock();
	if (configuredHidden !== undefined) state.processVisible = !configuredHidden;

	if (!state.originalShowStatus && typeof proto.showStatus === "function") {
		state.originalShowStatus = proto.showStatus;
		state.showStatusWrapper = function (this: unknown, message: string) {
			if (state && shouldMuteThinkingStatus(state, message)) return;
			return state?.originalShowStatus?.call(this, message);
		};
		proto.showStatus = state.showStatusWrapper;
	}

	if (!state.originalToggleThinking && typeof proto.toggleThinkingBlockVisibility === "function") {
		state.originalToggleThinking = proto.toggleThinkingBlockVisibility;
		state.toggleThinkingWrapper = function (this: ThinkingHost) {
			const result = state!.originalToggleThinking?.call(this);
			state!.activeMode = this;
			if (typeof this.hideThinkingBlock === "boolean") {
				setProcessVisible(state!, !this.hideThinkingBlock);
			}
			return result;
		};
		proto.toggleThinkingBlockVisibility = state.toggleThinkingWrapper;
	}

	if (!state.originalUpdateThinking && typeof proto.updateThinkingBlockVisibility === "function") {
		state.originalUpdateThinking = proto.updateThinkingBlockVisibility;
		state.updateThinkingWrapper = function (this: ThinkingHost) {
			state!.activeMode = this;
			if (typeof this.hideThinkingBlock === "boolean") {
				setProcessVisible(state!, !this.hideThinkingBlock);
			}
			return state!.originalUpdateThinking?.call(this);
		};
		proto.updateThinkingBlockVisibility = state.updateThinkingWrapper;
	}

	const toolProto = ToolExecutionComponent.prototype as RenderHost;
	if (!state.originalToolRender && typeof toolProto.render === "function") {
		state.originalToolRender = toolProto.render;
		state.toolRenderWrapper = function (this: RenderHost, width: number) {
			if (state!.enabled && state!.processVisible === false) return [];
			return state!.originalToolRender!.call(this, width);
		};
		toolProto.render = state.toolRenderWrapper;
	}

	const bashProto = BashExecutionComponent.prototype as RenderHost;
	if (!state.originalBashRender && typeof bashProto.render === "function") {
		state.originalBashRender = bashProto.render;
		state.bashRenderWrapper = function (this: RenderHost, width: number) {
			if (state!.enabled && state!.processVisible === false) return [];
			return state!.originalBashRender!.call(this, width);
		};
		bashProto.render = state.bashRenderWrapper;
	}

	currentPatchState = state;
	return state;
}

function uninstallPatches(state: PatchState): void {
	state.enabled = false;
	state.generation += 1;
	state.desiredHidden = undefined;
	state.requestId += 1;
	state.activePump?.controller.abort();
	state.activePump = undefined;
	clearMute(state);
	state.activeMode = undefined;
	state.processVisible = undefined;

	const proto = InteractiveMode.prototype as unknown as PatchedInteractivePrototype;
	if (state.showStatusWrapper && proto.showStatus === state.showStatusWrapper) {
		proto.showStatus = state.originalShowStatus;
	}
	if (state.toggleThinkingWrapper && proto.toggleThinkingBlockVisibility === state.toggleThinkingWrapper) {
		proto.toggleThinkingBlockVisibility = state.originalToggleThinking;
	}
	if (
		state.updateThinkingWrapper &&
		proto.updateThinkingBlockVisibility === state.updateThinkingWrapper
	) {
		proto.updateThinkingBlockVisibility = state.originalUpdateThinking;
	}
	const toolProto = ToolExecutionComponent.prototype as RenderHost;
	if (state.toolRenderWrapper && toolProto.render === state.toolRenderWrapper) {
		toolProto.render = state.originalToolRender;
	}
	const bashProto = BashExecutionComponent.prototype as RenderHost;
	if (state.bashRenderWrapper && bashProto.render === state.bashRenderWrapper) {
		bashProto.render = state.originalBashRender;
	}

	// Keep the Symbol state reusable after `/reload`: the old wrappers were
	// restored above, so a later install must capture the current originals again.
	state.originalShowStatus = undefined;
	state.originalToggleThinking = undefined;
	state.originalUpdateThinking = undefined;
	state.originalToolRender = undefined;
	state.originalBashRender = undefined;
	state.showStatusWrapper = undefined;
	state.toggleThinkingWrapper = undefined;
	state.updateThinkingWrapper = undefined;
	state.toolRenderWrapper = undefined;
	state.bashRenderWrapper = undefined;
	currentPatchState = undefined;
}

async function waitUntilHidden(
	target: boolean,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (signal.aborted) return false;
		if (readHideThinkingBlock() === target) return true;
		await sleep(POLL_MS, signal);
	}
	return !signal.aborted && readHideThinkingBlock() === target;
}

async function sendCtrlT(
	pi: ExtensionAPI,
	signal: AbortSignal,
): Promise<boolean> {
	if (!PANE_ID || signal.aborted) return false;
	try {
		const result = await pi.exec("herdr", ["pane", "send-keys", PANE_ID, "ctrl+t"], {
			timeout: SEND_TIMEOUT_MS,
			signal,
		});
		return result.code === 0;
	} catch {
		return false;
	}
}

async function pump(pi: ExtensionAPI, state: PatchState, generation: number): Promise<void> {
	const requestId = state.requestId;
	const controller = new AbortController();
	if (state.activePump) return;
	state.activePump = { generation, requestId, controller };
	try {
		let unknownSince: number | undefined;
		while (
			state.enabled &&
			state.generation === generation &&
			state.requestId === requestId &&
			state.desiredHidden !== undefined &&
			!controller.signal.aborted
		) {
			const target = state.desiredHidden;
			const current = readHideThinkingBlock();
			if (current === undefined) {
				unknownSince ??= Date.now();
				if (Date.now() - unknownSince > UNKNOWN_FILE_MS) {
					if (state.requestId === requestId && state.desiredHidden === target) {
						state.desiredHidden = undefined;
					}
					unknownSince = undefined;
					// Do not leave stale hidden/visible state in the render wrappers.
					state.processVisible = undefined;
					continue;
				}
				try {
					await sleep(POLL_MS, controller.signal);
				} catch {
					return;
				}
				continue;
			}
			unknownSince = undefined;
			if (current === target) {
				if (state.requestId === requestId && state.desiredHidden === target) {
					setProcessVisible(state, !target, true);
					state.desiredHidden = undefined;
				}
				continue;
			}

			// 静音必须在 send 之前：按键由 TUI 在 await 期间处理。
			muteNextThinkingStatus(state);
			const sent = await sendCtrlT(pi, controller.signal);
			if (controller.signal.aborted) return;
			if (!sent) {
				if (state.muteCount > 0) state.muteCount -= 1;
				if (state.requestId === requestId && state.desiredHidden === target) {
					state.desiredHidden = undefined;
				}
				continue;
			}
			let reachedTarget: boolean;
			try {
				reachedTarget = await waitUntilHidden(
					target,
					WAIT_FOR_FILE_MS,
					controller.signal,
				);
			} catch {
				return;
			}
			if (state.generation !== generation || !state.enabled || controller.signal.aborted) return;
			if (reachedTarget && state.requestId === requestId && state.desiredHidden === target) {
				state.desiredHidden = undefined;
				// settings.json 变更后再明确同步一次；不要依赖 Ctrl+T wrapper 的时序。
				setProcessVisible(state, !target, true);
			} else if (!reachedTarget && state.requestId === requestId && state.desiredHidden === target) {
				// 没确认到目标状态时不猜测，也不把工具块误隐藏；下次 hook 再重试。
				state.desiredHidden = undefined;
				state.processVisible = undefined;
			}
		}
	} finally {
		if (state.activePump?.controller === controller) {
			state.activePump = undefined;
		}
		if (
			state.enabled &&
			state.generation === generation &&
			state.requestId === requestId &&
			state.desiredHidden !== undefined
		) {
			void pump(pi, state, generation);
		}
	}
}

function requestHidden(pi: ExtensionAPI, state: PatchState, hidden: boolean): void {
	state.desiredHidden = hidden;
	state.requestId += 1;
	if (state.activePump) {
		state.activePump.controller.abort();
		state.activePump = undefined;
	}
	void pump(pi, state, state.generation);
}

export default function (pi: ExtensionAPI): void {
	if (!ENABLED) return;

	const ensureTuiPatches = (ctx: ExtensionContext): PatchState | undefined => {
		if (!isTui(ctx)) return undefined;
		return installPatches();
	};

	pi.on("session_start", (_event, ctx) => {
		ensureTuiPatches(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		const state = ensureTuiPatches(ctx);
		if (!state) return;
		requestHidden(pi, state, false);
	});
	pi.on("agent_settled", (_event, ctx) => {
		const state = ensureTuiPatches(ctx);
		if (!state) return;
		requestHidden(pi, state, true);
	});
	pi.on("session_shutdown", () => {
		if (currentPatchState) uninstallPatches(currentPatchState);
	});
}
