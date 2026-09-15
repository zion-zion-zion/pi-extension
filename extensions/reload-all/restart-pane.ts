/**
 * 「重启某一个窗口」的 TS 版原语，给 `/restart-all` 用。
 *
 * 为什么放在 `reload-all/` 目录里、而不是 `extensions/restart.ts`：
 * 反向依赖会让 `/reload-all` 在「还没装 restart.ts」的机器上**直接加载失败**
 * （实测：2026-09-15 `Error: Failed to load extension ".../reload-all/index.ts":
 * Cannot find module '../restart.ts'`，整个 pi 起不来）。放在同一目录、只依赖 node，
 * 两个扩展就能各自独立安装。
 *
 * `/restart`（自己）用的是同一套四步的 Shell 版：它必须在「本进程已经不存在」之后才能执行，
 * 见 `extensions/restart.ts`。两份实现的存在理由与同步要求见设计文档「架构」。
 *
 * 设计文档：docs/superpowers/specs/2026-09-14-restart-design.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 往窗口里注入一条命令的超时。 */
export const HERDR_TIMEOUT_MS = 2_000;
/**
 * 等目标窗口退到 shell 的上限。
 * 实测（2026-09-15，w5:pF）：`/quit` 之后第 2 次轮询（约 0.5s）前台就变成 fish 了，10s 是余量。
 */
export const SHELL_WAIT_MS = 10_000;
const POLL_MS = 100;

export type PaneRestartTarget = { paneId: string; sessionRef: string };
export type PaneRestartResult = { ok: true } | { ok: false; error: string };

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function herdr(pi: ExtensionAPI, args: string[], timeoutMs = HERDR_TIMEOUT_MS): Promise<string> {
	const result = await pi.exec("herdr", args, { timeout: timeoutMs });
	if (result.code !== 0) {
		const detail = String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim();
		throw new Error(`herdr ${args.join(" ")} 退出码 ${result.code}${detail ? `：${detail}` : ""}`);
	}
	return String(result.stdout ?? "");
}

async function herdrJson(pi: ExtensionAPI, args: string[]): Promise<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(await herdr(pi, args));
	if (parsed && typeof parsed === "object" && "result" in parsed) {
		return ((parsed as { result: unknown }).result ?? {}) as Record<string, unknown>;
	}
	return (parsed ?? {}) as Record<string, unknown>;
}

/**
 * 目标窗口的前台进程还是不是 pi。
 * `undefined` 表示没问到（调用方按「不确定」处理，继续等而不是放行）。
 */
async function foregroundIsPi(pi: ExtensionAPI, paneId: string): Promise<boolean | undefined> {
	try {
		const result = await herdrJson(pi, ["pane", "process-info", "--pane", paneId]);
		const info = result.process_info as { foreground_processes?: unknown } | undefined;
		const procs = info?.foreground_processes;
		if (!Array.isArray(procs) || procs.length === 0) return undefined;
		return procs.some((entry) => (entry as { argv0?: unknown }).argv0 === "pi");
	} catch {
		return undefined;
	}
}

/**
 * 重启某一个窗口：`/quit` → 等它退到 shell → `pi --session <它的会话文件>`。
 *
 * 「等它退到 shell」是安全闸门：不确定它还在 pi 里时，**绝不**注入 `pi` —— 那行字会被灌进
 * 对方的输入框当成消息。宁可少重启一个窗口，也不污染别人的对话。
 */
export async function restartPane(pi: ExtensionAPI, target: PaneRestartTarget): Promise<PaneRestartResult> {
	const { paneId, sessionRef } = target;
	if (paneId === "" || sessionRef === "") return { ok: false, error: "缺少 pane id 或会话记录" };

	try {
		await herdr(pi, ["pane", "run", paneId, "/quit"]);
	} catch (error) {
		return { ok: false, error: `注入 /quit 失败：${errText(error)}` };
	}

	const deadline = Date.now() + SHELL_WAIT_MS;
	while (Date.now() < deadline) {
		if ((await foregroundIsPi(pi, paneId)) === false) break;
		await sleep(POLL_MS);
	}
	if ((await foregroundIsPi(pi, paneId)) !== false) {
		return { ok: false, error: `等 ${SHELL_WAIT_MS / 1000}s 仍没退到 shell，已放弃（未注入 pi）` };
	}

	try {
		// 整条命令作为一个参数传、引号显式写出来：herdr 是「文本 + 回车」原样发进目标 shell，
		// 路径含空格/中文都不会被拆开（2026-09-15 在 w5:pF 实测过）。
		await herdr(pi, ["pane", "run", paneId, `pi --session "${sessionRef}"`]);
	} catch (error) {
		return { ok: false, error: `注入 pi 失败：${errText(error)}` };
	}
	return { ok: true };
}
