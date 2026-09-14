/**
 * 每轮结束后，把「我上一条消息」的第一行顶到视口顶部（仅 fullscreen TUI）。
 *
 * 为什么需要：pi 回复完会停在内容末尾，而 thinking / 工具块又被 auto-hide-thinking
 * 收起了，用户想读本轮回复还得自己往上翻到自己的消息处。这里在 agent_settled 时替用户翻好。
 *
 * 为什么不用内置的 tui.altScreen.previousPrompt（Ctrl+Shift+Up）：
 *  1. 它的语义是「上一格标记消息」——从视口顶部往上扫第一个 OSC 133;A 行。回复比一屏短时，
 *     用户消息本来就在屏幕上，它会多跳一整轮。
 *  2. 不能只扫 133;A：AssistantMessageComponent 在「该条消息没有工具调用」时也会加同一个
 *     前缀，纯文本回复的首行同样命中，会定位成回复开头而不是用户消息。
 * 所以这里自己标记 UserMessageComponent 渲染后的首行，从下往上精确命中最后一条用户消息。
 *
 * 不 import @earendil-works/pi-tui 的任何类：pi 的 TUI 被内联打包进 dist/bundle/chunks/，
 * 扩展解析到的是 node_modules 里另一份拷贝，patch 它的 prototype 对运行中的 pi 无效
 * （pi 自己就因此用 Symbol.for 做跨拷贝标识）。这里只做鸭子类型，layout 遍历自己写。
 *
 * 状态都挂在 prototype 的 Symbol 上、跨 /reload 复用（同 auto-hide-thinking.ts）。
 */

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	InteractiveMode,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TRACE_PATH = join(getAgentDir(), "scroll-to-last-prompt.log");
const TRACE_MAX_BYTES = 128 * 1024;

const USER_LINES_KEY = Symbol.for("pi-extension.scroll-to-last-prompt.user-lines");
const MODE_KEY = Symbol.for("pi-extension.scroll-to-last-prompt.interactive-mode");

/**
 * 改字段就 +1：跨 /reload 复用的旧对象字段对不上时整体重建，不用为每个新字段补兼容判断。
 * （教训见 auto-hide-thinking.ts：旧对象缺字段会让判定静默失效。）
 */
const STATE_VERSION = 1;

type RenderFn = (this: unknown, width: number) => string[];
type EventFn = (this: unknown, event: unknown) => unknown;

/** 只用到 ScrollView 的这几个成员；刻意不 import pi-tui 的类型。 */
type ScrollViewLike = {
	readonly scrollTop: number;
	readonly isFollowingEnd: boolean;
	scrollTo: (scrollTop: number, options?: { disableFollow?: boolean }) => void;
	scrollToEnd: () => void;
};

/** pi-tui 的 LayoutBox / LayoutFrame 中本扩展用到的字段。 */
type LayoutBoxLike = {
	readonly scrollView?: ScrollViewLike;
	readonly scrollContentLines?: readonly string[];
	readonly children?: readonly LayoutBoxLike[];
};

type LayoutFrameLike = {
	readonly root?: LayoutBoxLike;
	readonly primaryScrollView?: ScrollViewLike;
};

/** fullscreen 下 instance.ui 是 TuiAltScreen 的代理，经它透传这些成员。 */
type TuiLike = {
	readonly mode?: string;
	readonly currentLayout?: LayoutFrameLike;
	requestRender?: (force?: boolean) => void;
};

type InteractiveHost = {
	ui?: TuiLike;
	transcriptScrollView?: ScrollViewLike;
	handleEvent?: EventFn;
};

type UserLinesState = {
	version: number;
	/**
	 * 每条用户消息渲染后首行的字符串。只增不减：量级是「本进程里出现过的用户消息条数」，
	 * 用字符串相等判定即可（Container.render 原样拼接子组件的行，不做任何前缀加工）。
	 */
	firstLines: Set<string>;
	original?: RenderFn;
	wrapper?: RenderFn;
};

type ModeState = {
	version: number;
	enabled: boolean;
	original?: EventFn;
	wrapper?: EventFn;
	/** 本 pane 的 InteractiveMode。/reload 不换 TUI 实例，所以保留这个引用。 */
	host?: InteractiveHost;
	/** 本扩展造成的「已脱离自动跟随」状态，用于下次发送消息时恢复。 */
	pinned?: { scrollView: ScrollViewLike; tui: TuiLike };
};

function trace(message: string): void {
	try {
		const line = `${new Date().toISOString()} pid=${process.pid} ${message}\n`;
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

function readState<T>(proto: object, key: symbol): T | undefined {
	return (proto as Record<symbol, T | undefined>)[key];
}

function writeState<T>(proto: object, key: symbol, value: T): void {
	(proto as Record<symbol, T>)[key] = value;
}

/** 找 frame 里 scrollView === target 的 box；等价于 pi-tui 的 getScrollViewBox，只是纯属性遍历。 */
function findScrollBox(
	box: LayoutBoxLike | undefined,
	target: ScrollViewLike,
): LayoutBoxLike | undefined {
	if (!box) return undefined;
	if (box.scrollView === target) return box;
	for (const child of box.children ?? []) {
		const hit = findScrollBox(child, target);
		if (hit) return hit;
	}
	return undefined;
}

/** 从下往上找第一条用户消息的首行；找不到返回 -1。 */
function lastUserLineRow(lines: readonly string[], firstLines: Set<string>): number {
	for (let row = lines.length - 1; row >= 0; row -= 1) {
		const line = lines[row];
		if (line !== undefined && firstLines.has(line)) return row;
	}
	return -1;
}

function installUserLinesPatch(): UserLinesState | undefined {
	const proto = UserMessageComponent.prototype as unknown as { render?: RenderFn };
	if (typeof proto.render !== "function") {
		trace("放弃：UserMessageComponent.prototype.render 不存在");
		return undefined;
	}
	const target = UserMessageComponent.prototype as object;
	let state = readState<UserLinesState>(target, USER_LINES_KEY);
	if (state && state.version !== STATE_VERSION) {
		if (state.wrapper && proto.render === state.wrapper) proto.render = state.original;
		trace(`user-lines state 版本 ${state.version} → ${STATE_VERSION}，重建`);
		state = undefined;
	}
	if (state?.wrapper && proto.render === state.wrapper) return state;

	// 正常 /reload 会在 session_shutdown 里还原 prototype；这里以「当前」的 render 为原始方法，
	// 兼容「卸载没跑、包装还留着」的重载实现。
	const original = proto.render;
	const next: UserLinesState = state ?? { version: STATE_VERSION, firstLines: new Set<string>() };
	next.version = STATE_VERSION;
	next.original = original;
	next.wrapper = function (this: unknown, width: number): string[] {
		const lines = original.call(this, width);
		const first = lines[0];
		if (first !== undefined) next.firstLines.add(first);
		return lines;
	};
	proto.render = next.wrapper;
	writeState(target, USER_LINES_KEY, next);
	trace(`安装 UserMessageComponent.render 包装（已有标记 ${next.firstLines.size} 条）`);
	return next;
}

function uninstallUserLinesPatch(): void {
	const proto = UserMessageComponent.prototype as unknown as { render?: RenderFn };
	const target = UserMessageComponent.prototype as object;
	const state = readState<UserLinesState>(target, USER_LINES_KEY);
	if (state?.wrapper && proto.render === state.wrapper) proto.render = state.original;
	// 保留 Symbol 上的 state（含已收集的首行）：下次安装直接复用。
}

function installModePatch(): ModeState | undefined {
	const proto = InteractiveMode.prototype as unknown as InteractiveHost;
	if (typeof proto.handleEvent !== "function") {
		trace("放弃：InteractiveMode.prototype.handleEvent 不存在");
		return undefined;
	}
	const target = InteractiveMode.prototype as object;
	let state = readState<ModeState>(target, MODE_KEY);
	if (state && state.version !== STATE_VERSION) {
		if (state.wrapper && proto.handleEvent === state.wrapper) proto.handleEvent = state.original;
		trace(`mode state 版本 ${state.version} → ${STATE_VERSION}，重建`);
		state = undefined;
	}
	if (state?.wrapper && proto.handleEvent === state.wrapper) {
		state.enabled = true;
		return state;
	}

	const original = proto.handleEvent;
	const next: ModeState = state ?? { version: STATE_VERSION, enabled: false };
	next.version = STATE_VERSION;
	next.enabled = true;
	next.original = original;
	next.wrapper = function (this: unknown, event: unknown): unknown {
		// handleEvent 每个 agent 事件都走一遍，是拿本 pane 实例最稳的地方。
		next.host = this as InteractiveHost;
		return original.call(this, event);
	};
	proto.handleEvent = next.wrapper;
	writeState(target, MODE_KEY, next);
	trace("安装 InteractiveMode.handleEvent 包装");
	return next;
}

function uninstallModePatch(): void {
	const proto = InteractiveMode.prototype as unknown as InteractiveHost;
	const target = InteractiveMode.prototype as object;
	const state = readState<ModeState>(target, MODE_KEY);
	if (!state) return;
	state.enabled = false;
	state.pinned = undefined;
	if (state.wrapper && proto.handleEvent === state.wrapper) proto.handleEvent = state.original;
	// 保留 host / Symbol 上的 state：同一个 TUI 实例，reload 后还要靠它取 currentLayout。
	// original/wrapper 也保留：proto.handleEvent === state.wrapper 这个判断就是「包装是否还在」的
	// 唯一依据——正常卸载后原型已还原，下次安装会重新捕获当时的原型方法。
	trace("卸载 InteractiveMode.handleEvent 包装");
}

/**
 * agent_settled 时调用。任何一步拿不到需要的东西都静默空操作，绝不打断 pi。
 */
function pinToLastUserMessage(state: ModeState, firstLines: Set<string>): void {
	try {
		if (!state.enabled) return;
		const host = state.host;
		const tui = host?.ui;
		if (!host || !tui) {
			trace("pin:skip 尚未捕获本 pane 实例");
			return;
		}
		// regular / print / rpc 下静默空操作：每轮都会走到这里，不刷日志。
		if (tui.mode !== "fullscreen") return;

		const frame = tui.currentLayout;
		const scrollView = frame?.primaryScrollView ?? host.transcriptScrollView;
		if (!frame?.root || !scrollView) {
			trace("pin:skip 拿不到 fullscreen layout");
			return;
		}
		// 方案 A：生成期间用户手动往上翻过，就尊重他的位置。
		if (scrollView.isFollowingEnd !== true) {
			trace("pin:skip 用户已手动上翻");
			return;
		}

		const lines = findScrollBox(frame.root, scrollView)?.scrollContentLines;
		if (!lines || lines.length === 0) {
			trace("pin:skip 拿不到 scrollContentLines");
			return;
		}
		const row = lastUserLineRow(lines, firstLines);
		if (row < 0) {
			trace(`pin:skip 未匹配到用户消息首行（已标记 ${firstLines.size} 条，共 ${lines.length} 行）`);
			return;
		}

		scrollView.scrollTo(row);
		tui.requestRender?.();
		if (scrollView.isFollowingEnd === true) {
			// 回复不足一屏，scrollTo 被 clamp 到内容末端：仍然跟随最新，不算吸附。
			trace(`pin:clamped row=${row} 内容不足一屏，保持跟随`);
			return;
		}
		state.pinned = { scrollView, tui };
		trace(`pin:ok row=${row} scrollTop=${scrollView.scrollTop} 共 ${lines.length} 行`);
	} catch (error) {
		trace(`pin:threw ${String(error)}`);
	}
}

/** 用户发送新消息时调用：把上一步吸附造成的「不跟随」恢复回来。 */
function resumeFollowing(state: ModeState): void {
	const pinned = state.pinned;
	if (!pinned) return;
	state.pinned = undefined;
	try {
		pinned.scrollView.scrollToEnd();
		pinned.tui.requestRender?.();
		trace("resume:ok 恢复自动跟随");
	} catch (error) {
		trace(`resume:threw ${String(error)}`);
	}
}

export default function (pi: ExtensionAPI): void {
	trace("factory loaded");

	let userLines: UserLinesState | undefined;
	let modeState: ModeState | undefined;

	const ensure = (ctx: ExtensionContext): boolean => {
		if (ctx.mode !== "tui") return false;
		userLines ??= installUserLinesPatch();
		modeState ??= installModePatch();
		return Boolean(userLines && modeState);
	};

	pi.on("session_start", (_event, ctx) => {
		trace(`session_start mode=${ctx.mode}`);
		ensure(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ensure(ctx)) return;
		trace("agent_settled");
		pinToLastUserMessage(modeState!, userLines!.firstLines);
	});

	pi.on("input", (event, ctx) => {
		if (!ensure(ctx)) return;
		// 排队型 follow-up（alt+enter）不跳走：用户可能正在读当前回复。
		if (event.streamingBehavior === "followUp") {
			trace("input:skip followUp 排队消息，不恢复跟随");
			return;
		}
		resumeFollowing(modeState!);
	});

	pi.on("session_shutdown", () => {
		uninstallModePatch();
		uninstallUserLinesPatch();
		modeState = undefined;
		userLines = undefined;
	});
}
