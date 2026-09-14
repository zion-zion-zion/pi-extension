/**
 * Herdr 下按 Ctrl+T 联动显示 / 隐藏思考过程和工具输出。
 *
 * 没有官方 setHideThinkingBlock API：拿**本 pane 自己的** hideThinkingBlock 当基准，
 * 和目标不一致时用 `herdr pane send-keys <pane> ctrl+t` 翻转一次。
 *
 * 基准不能取 settings.json：那个文件被所有 pane 共享，别的窗口一按键它就变了。
 * 拿它当基准的话，本 pane 会误判「已经是目标值」而跳过注入，thinking 永远不展开。
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

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const TRACE_PATH = join(getAgentDir(), "auto-hide-thinking.log");
const TRACE_MAX_BYTES = 128 * 1024;
const SEND_TIMEOUT_MS = 2_000;
const WAIT_FOR_FILE_MS = 1_500;
const UNKNOWN_FILE_MS = 1_500;
/** 等本 pane 实例被捕获的宽限期，超时才退回全局 settings.json。 */
const MODE_WAIT_MS = 600;
const POLL_MS = 25;
const MUTE_MS = 1_500;
const THINKING_STATUS = /^Thinking blocks: (?:hidden|visible)$/;

const PATCH_STATE = Symbol.for("pi-extension.auto-hide-thinking.patchState");

/**
 * state 存在 prototype 的 Symbol 上、跨 /reload 复用，字段随版本演进。
 * 改字段就 +1，旧对象会在 installPatches 里被重置 —— 不用为每个新字段补兼容判断。
 *
 * 教训：曾经因为旧对象缺 `requestId`，`undefined + 1` 变成 NaN，而 NaN === NaN 恒为
 * false，判定循环一次都不进，静默地什么都不做（thinking 永远不展开、工具块永远不收）。
 */
const STATE_VERSION = 1;

type ThinkingHost = {
	hideThinkingBlock?: boolean;
	ui?: {
		requestRender?: () => void;
	};
	handleEvent?: (event: unknown) => unknown;
	toggleThinkingBlockVisibility?: () => void;
	updateThinkingBlockVisibility?: () => void;
	showStatus?: (message: string) => void;
};

type RenderHost = {
	render?: (width: number) => string[];
};

type PatchState = {
	/** 字段形状版本，见 STATE_VERSION。 */
	version: number;
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
	originalHandleEvent?: (event: unknown) => unknown;
	originalToggleThinking?: () => void;
	originalUpdateThinking?: () => void;
	originalToolRender?: (width: number) => string[];
	originalBashRender?: (width: number) => string[];
	showStatusWrapper?: (message: string) => void;
	handleEventWrapper?: (event: unknown) => unknown;
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

/**
 * 诊断用日志。只记「装/卸补丁」和「状态被降级成未知」这两类事件，一轮对话最多几条，
 * 所以常开。写文件而不是 stderr —— TUI 下往 stderr 写会打乱画面。
 */
function trace(message: string): void {
	try {
		const line = `${new Date().toISOString()} ${PANE_ID ?? "-"} ${message}\n`;
		let size = 0;
		try {
			size = statSync(TRACE_PATH).size;
		} catch {
			size = 0;
		}
		if (size > TRACE_MAX_BYTES) writeFileSync(TRACE_PATH, line);
		else appendFileSync(TRACE_PATH, line);
	} catch {
		// 诊断不能影响主流程。
	}
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

/**
 * 本 pane 自己的 thinking 可见性。
 *
 * settings.json 是所有 pane 共享的全局文件：其它窗口一按键它就会变，所以它只能当
 * 兜底，不能拿来判定「本 pane 已经是目标值了」——否则别的窗口展开过，本 pane 就会
 * 误以为自己也展开了，直接跳过注入 Ctrl+T，thinking 永远不展开。
 */
function readPaneHidden(state: PatchState): boolean | undefined {
	const live = state.activeMode?.hideThinkingBlock;
	if (typeof live === "boolean") return live;
	return readHideThinkingBlock();
}

/**
 * 诊断专用：把两个来源都读出来对照，只在决策点调用（比 readPaneHidden 多读一次文件）。
 *
 * 存在的理由：判定用的是「本 pane 实例字段」，但屏幕上真正渲染的内容由 Pi 的
 * updateThinkingBlockVisibility() 同步（只有 Ctrl+T 和设置面板两处会调），字段和屏幕
 * 确实可能不一致 —— 所以每个「决定什么都不做」的地方都必须同时留下两个来源的值。
 */
function describeSources(state: PatchState): string {
	const live = state.activeMode?.hideThinkingBlock;
	const liveValue = typeof live === "boolean" ? live : undefined;
	const file = readHideThinkingBlock();
	const disagree = liveValue !== undefined && file !== undefined && liveValue !== file;
	return `live=${liveValue ?? "-"} file=${file ?? "-"}${disagree ? " ⚠️DISAGREE" : ""}`;
}

/** 同上，但给实例捕获一点时间（agent_start 与 pi 自己的 handleEvent 同一轮到达）。 */
async function resolvePaneHidden(
	state: PatchState,
	signal: AbortSignal,
): Promise<boolean | undefined> {
	const deadline = Date.now() + MODE_WAIT_MS;
	for (;;) {
		const live = state.activeMode?.hideThinkingBlock;
		if (typeof live === "boolean") return live;
		if (Date.now() >= deadline) {
			trace(`resolvePaneHidden 未在 ${MODE_WAIT_MS}ms 内捕获本 pane 实例，退回全局 settings.json`);
			return readHideThinkingBlock();
		}
		try {
			await sleep(POLL_MS, signal);
		} catch {
			return undefined;
		}
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
	if (state && state.version !== STATE_VERSION) {
		// 跨 /reload 复用的旧对象，字段对不上：先卸掉它可能残留的 wrapper，再整体舍掉重建。
		trace(`state 版本 ${state.version} → ${STATE_VERSION}，重置`);
		uninstallPatches(state);
		state = undefined;
	}
	if (!state) {
		state = {
			version: STATE_VERSION,
			enabled: false,
			generation: 0,
			processVisible: undefined,
			muteCount: 0,
			requestId: 0,
		};
		proto[PATCH_STATE] = state;
	} else if (!Number.isInteger(state.requestId)) {
		// 保险：万一将来改了字段忘了 +1 版本号，也不要让 NaN 把整个判定循环废掉
		// （NaN === NaN 恒为 false）。
		trace("state.requestId 不是整数，就地修正");
		state.requestId = 0;
	}

	// A normal /reload restores the old wrappers during session_shutdown. This
	// branch also handles a reload implementation that leaves the wrappers in place.
	if (state.enabled) return state;
	state.enabled = true;
	state.generation += 1;
	// 故意不清 activeMode：/reload 只换扩展和资源，TUI 实例本身没变，留着这个引用
	// 才能在下面 requestRender。
	state.desiredHidden = undefined;
	state.requestId += 1;
	state.activePump?.controller.abort();
	state.activePump = undefined;
	clearMute(state);

	const configuredHidden = readPaneHidden(state);
	// session.reload() 的顺序是 beforeSessionStart()（重画聊天区）→ session_start
	// （这时才装补丁），所以聊天区刚被「还没补丁」的原生 render 画过一遍。这里必须走
	// setProcessVisible 并带上 requestRender，否则屏幕上会一直留着展开的工具块，
	// 直到下一次碰巧的渲染请求。
	if (configuredHidden !== undefined) setProcessVisible(state, !configuredHidden, true);
	trace(
		`install configuredHidden=${configuredHidden} live=${state.activeMode ? "yes" : "no"} processVisible=${state.processVisible} ${describeSources(state)}`,
	);

	if (!state.originalShowStatus && typeof proto.showStatus === "function") {
		state.originalShowStatus = proto.showStatus;
		state.showStatusWrapper = function (this: unknown, message: string) {
			// showStatus 调用频繁，顺手把 TUI 引用捞回来（install 需要它来 requestRender）。
			if (state) state.activeMode = this as ThinkingHost;
			if (state && shouldMuteThinkingStatus(state, message)) return;
			return state?.originalShowStatus?.call(this, message);
		};
		proto.showStatus = state.showStatusWrapper;
	}

	// handleEvent 每个 agent 事件都走一遍，是拿本 pane 实例最稳的地方。
	if (!state.originalHandleEvent && typeof proto.handleEvent === "function") {
		state.originalHandleEvent = proto.handleEvent;
		state.handleEventWrapper = function (this: ThinkingHost, event: unknown) {
			const firstCapture = state!.activeMode !== this;
			state!.activeMode = this;
			if (firstCapture) {
				// 第一次拿到本 pane 实例：整个「判定改用本 pane 状态」方案的地基，必须留痕。
				trace(`handleEvent 捕获本 pane 实例 hideThinkingBlock=${this.hideThinkingBlock}`);
			}
			const hidden = this.hideThinkingBlock;
			if (typeof hidden === "boolean" && state!.processVisible !== !hidden) {
				// 本 pane 的思考可见性变了（注入的 Ctrl+T / 手动按键 / 设置面板），
				// 工具块跟着走，不要等下一次 hook。
				setProcessVisible(state!, !hidden, true);
			}
			return state!.originalHandleEvent!.call(this, event);
		};
		proto.handleEvent = state.handleEventWrapper;
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
	// activeMode 同样保留：同一个 TUI 实例，reload 后还要靠它 requestRender。
	state.processVisible = undefined;

	const proto = InteractiveMode.prototype as unknown as PatchedInteractivePrototype;
	if (state.showStatusWrapper && proto.showStatus === state.showStatusWrapper) {
		proto.showStatus = state.originalShowStatus;
	}
	if (state.handleEventWrapper && proto.handleEvent === state.handleEventWrapper) {
		proto.handleEvent = state.originalHandleEvent;
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
	state.originalHandleEvent = undefined;
	state.originalToggleThinking = undefined;
	state.originalUpdateThinking = undefined;
	state.originalToolRender = undefined;
	state.originalBashRender = undefined;
	state.showStatusWrapper = undefined;
	state.handleEventWrapper = undefined;
	state.toggleThinkingWrapper = undefined;
	state.updateThinkingWrapper = undefined;
	state.toolRenderWrapper = undefined;
	state.bashRenderWrapper = undefined;
	currentPatchState = undefined;
	trace("uninstall");
}

async function waitUntilHidden(
	state: PatchState,
	target: boolean,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (signal.aborted) return false;
		if (readPaneHidden(state) === target) return true;
		await sleep(POLL_MS, signal);
	}
	return !signal.aborted && readPaneHidden(state) === target;
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
		trace(`sendCtrlT code=${result.code} stderr=${result.stderr.slice(0, 120)}`);
		return result.code === 0;
	} catch (error) {
		trace(`sendCtrlT threw ${String(error)}`);
		return false;
	}
}

async function pump(pi: ExtensionAPI, state: PatchState, generation: number): Promise<void> {
	const requestId = state.requestId;
	const controller = new AbortController();
	if (state.activePump) {
		trace(`pump:skip 已有 activePump（gen=${generation} req=${requestId}）`);
		return;
	}
	state.activePump = { generation, requestId, controller };
	try {
		let unknownSince: number | undefined;
		let entered = false;
		for (;;) {
			// 逐条显式判定退出原因。之前是在循环退出“之后”才读条件，值可能已经被别处改掉，
			// 导致日志说谎（比如报 reqMatch=false 但其实是另一个条件没过）。
			const stopReason = !state.enabled
				? "enabled=false"
				: state.generation !== generation
					? `generation ${state.generation}!=${generation}`
					: state.requestId !== requestId
						? `requestId ${state.requestId}!=${requestId}`
						: state.desiredHidden === undefined
							? "desiredHidden=undefined"
							: controller.signal.aborted
								? "aborted"
								: undefined;
			if (stopReason !== undefined) {
				// 正常退出（比如 current===target 后 desiredHidden 被清空）不刷日志，只记畸形的静默退出。
				if (!entered) trace(`pump:exit 未进入循环 原因=${stopReason}`);
				break;
			}
			entered = true;
			const target = state.desiredHidden;
			const current = await resolvePaneHidden(state, controller.signal);
			if (current === undefined) {
				unknownSince ??= Date.now();
				if (Date.now() - unknownSince > UNKNOWN_FILE_MS) {
					if (state.requestId === requestId && state.desiredHidden === target) {
						state.desiredHidden = undefined;
					}
					unknownSince = undefined;
					// Do not leave stale hidden/visible state in the render wrappers.
					trace(`processVisible=undefined 连续 ${UNKNOWN_FILE_MS}ms 读不到 ${describeSources(state)}`);
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
					// 不注入、不改文件，是「静默什么都不做」的唯一出口，必须留痕。
					trace(`pump:already target=${target} current=${current} ${describeSources(state)}`);
					setProcessVisible(state, !target, true);
					state.desiredHidden = undefined;
				}
				continue;
			}

			// 静音必须在 send 之前：按键由 TUI 在 await 期间处理。
			muteNextThinkingStatus(state);
			trace(`pump:decide target=${target} current=${current} ${describeSources(state)}`);
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
					state,
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
				trace(`processVisible=undefined ctrl+t 未在 1.5s 内确认 target=${target}`);
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
	trace(
		`requestHidden hidden=${hidden} requestId ${state.requestId}→${state.requestId + 1} gen=${state.generation} activePump=${state.activePump ? "yes" : "-"}`,
	);
	state.desiredHidden = hidden;
	state.requestId += 1;
	if (state.activePump) {
		state.activePump.controller.abort();
		state.activePump = undefined;
	}
	void pump(pi, state, state.generation);
}

export default function (pi: ExtensionAPI): void {
	trace(`factory loaded enabled=${ENABLED}`);
	if (!ENABLED) return;

	const ensureTuiPatches = (ctx: ExtensionContext): PatchState | undefined => {
		if (!isTui(ctx)) return undefined;
		return installPatches();
	};

	pi.on("session_start", (_event, ctx) => {
		trace(`session_start mode=${ctx.mode}`);
		ensureTuiPatches(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		trace(`agent_start mode=${ctx.mode}`);
		const state = ensureTuiPatches(ctx);
		if (!state) {
			trace("agent_start 无补丁状态");
			return;
		}
		requestHidden(pi, state, false);
	});
	pi.on("agent_settled", (_event, ctx) => {
		trace(`agent_settled mode=${ctx.mode}`);
		const state = ensureTuiPatches(ctx);
		if (!state) {
			trace("agent_settled 无补丁状态");
			return;
		}
		requestHidden(pi, state, true);
	});
	pi.on("session_shutdown", () => {
		if (currentPatchState) uninstallPatches(currentPatchState);
	});
}
