/**
 * 启动时自动同步 pi 配置（双向同步 ~/.pi/agent 远端仓库）。
 *
 * 复用 LaunchAgent 同款脚本 scripts/backup.sh：
 *   1. 提交本机改动（settings.json 里的模型选择会被剥掉，不进 git）
 *   2. fetch + rebase 拉远端；settings.json 冲突自动三路合并
 *   3. 本地超前则 push
 *
 * 触发时机：pi 启动（session_start reason="startup"）时 await 同步一次。
 * 注意：拉到的新扩展 / 新 prompt 不会在本次会话自动生效，需 /reload 才加载。
 * 所以这更多是「保证下次启动或重载时拿到最新配置」。
 *
 * 手动触发：/pi-sync
 * 关闭：环境变量 PI_STARTUP_SYNC=0 / off / false
 */

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
const SYNC_SCRIPT = join(AGENT_DIR, "scripts", "backup.sh");
const LOG_FILE = join(AGENT_DIR, "backup.log");
const SYNC_TIMEOUT_MS = 20_000;
const MAX_LINES_REPORT = 4;

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
};

// session_start 的 ExtensionContext 和 command 的 ExtensionCommandContext
// 都带有 hasUI 与 ui.notify，这里用最小结构接口保证类型安全。
type NotifyContext = {
	hasUI?: boolean;
	ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
};

function syncEnabled(): boolean {
	const v = (process.env.PI_STARTUP_SYNC || "1").trim().toLowerCase();
	return !(v === "0" || v === "off" || v === "false" || v === "no");
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function readLogLines(): Promise<string[]> {
	try {
		const content = await readFile(LOG_FILE, "utf8");
		return content.split(/\r?\n/).filter(Boolean);
	} catch {
		return [];
	}
}

function notify(ctx: NotifyContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui?.notify(message, level);
}

async function runSync(pi: ExtensionAPI, ctx: NotifyContext): Promise<void> {
	if (!(await exists(SYNC_SCRIPT))) {
		notify(ctx, `配置同步脚本不存在: ${SYNC_SCRIPT}`, "warning");
		return;
	}

	const before = await readLogLines();
	let result: ExecResult;
	try {
		result = await pi.exec("bash", [SYNC_SCRIPT], { timeout: SYNC_TIMEOUT_MS });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		notify(ctx, `配置同步异常: ${msg}`, "error");
		return;
	}

	const after = await readLogLines();
	const added = after.slice(before.length).filter(Boolean);

	if (result.code !== 0) {
		const detail = added.join(" ").trim() || result.stderr.trim() || "未知错误";
		notify(ctx, `配置同步失败: ${detail}`, "error");
		return;
	}

	if (added.length > 0) {
		const summary = added.slice(-MAX_LINES_REPORT).join("\n");
		notify(ctx, `✅ 配置已同步:\n${summary}\n(如需加载新扩展，请 /reload)`, "info");
	} else {
		notify(ctx, "✅ 配置已同步（无变更）", "info");
	}
}

export default function (pi: ExtensionAPI) {
	// 仅在 pi 启动时同步一次；new/resume/fork/reload 不重复跑，避免每次切会话都动 git。
	pi.on("session_start", (event, ctx) => {
		if (!syncEnabled()) return;
		if (event?.reason !== "startup") return;
		void runSync(pi, ctx);
	});

	pi.registerCommand("pi-sync", {
		description: "手动同步 pi 配置（拉取/推送 ~/.pi/agent 远端仓库）",
		handler: async (_args, ctx) => {
			await runSync(pi, ctx);
		},
	});
}
