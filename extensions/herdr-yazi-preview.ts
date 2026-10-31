import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function resolveClipboardPath(clipboard: string, cwd: string): Promise<string> {
	let input = clipboard.trim();
	if (!input || /[\x00-\x1f\x7f]/.test(input)) throw new Error("剪贴板需要包含单个文件或目录路径");
	const markdown = input.match(/^\[[^\]]*\]\((?:<([^>]+)>|([^()]+))\)$/);
	if (markdown) input = markdown[1] ?? markdown[2];
	if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'")) || (input.startsWith("`") && input.endsWith("`"))) input = input.slice(1, -1);
	if (input.startsWith("file://")) {
		try { input = fileURLToPath(input); } catch { throw new Error("文件链接无效或不是本地路径"); }
	}
	if (input === "~" || input.startsWith("~/")) input = homedir() + input.slice(1);
	const absolute = isAbsolute(input) ? input : resolve(cwd, input);
	const candidates = [absolute, absolute.replace(/:\d+(?::\d+|[-–]\d+)?$/, "")];
	for (const path of new Set(candidates)) {
		try {
			const info = await stat(path);
			if (info.isFile() || info.isDirectory()) return path;
		} catch { /* try without a line suffix */ }
	}
	throw new Error(`找不到文件或目录：${input}`);
}

export default function (pi: ExtensionAPI) {
	let opening = false;
	async function open(ctx: ExtensionContext) {
		if (opening) return;
		if (ctx.mode !== "tui" || process.platform !== "darwin" || process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
			if (ctx.hasUI) ctx.ui.notify("Yazi 预览需要在 macOS 的 Herdr Pi 窗口中使用", "warning");
			return;
		}
		opening = true;
		let pane: string | undefined;
		try {
			const clip = await pi.exec("pbpaste", [], { timeout: 3000 });
			if (clip.code !== 0) throw new Error(`无法读取剪贴板：${clip.stderr.trim()}`);
			const path = await resolveClipboardPath(clip.stdout, ctx.cwd);
			const split = await pi.exec("herdr", ["pane", "split", "--pane", process.env.HERDR_PANE_ID, "--direction", "right", "--cwd", ctx.cwd, "--env", `YAZI_PREVIEW_PATH=${path}`, "--focus"], { timeout: 10000 });
			if (split.code !== 0) throw new Error(`创建预览窗口失败：${split.stderr.trim()}`);
			const result = JSON.parse(split.stdout);
			pane = result?.result?.pane?.pane_id;
			if (!pane) throw new Error("Herdr 未返回新窗口 ID");
			const command = `sh -c 'command yazi -- "$YAZI_PREVIEW_PATH"; command herdr pane close "$HERDR_PANE_ID"'`;
			const run = await pi.exec("herdr", ["pane", "run", pane, command], { timeout: 10000 });
			if (run.code !== 0) throw new Error(`启动 Yazi 失败：${run.stderr.trim()}`);
		} catch (error) {
			if (pane) await pi.exec("herdr", ["pane", "close", pane], { timeout: 5000 }).catch(() => {});
			ctx.ui.notify(`Yazi 预览：${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			opening = false;
		}
	}
	pi.registerShortcut("ctrl+alt+y", { description: "用 Yazi 预览剪贴板路径", handler: open });
	pi.registerCommand("yazi-preview", { description: "在 Herdr 中预览剪贴板路径", handler: async (_args, ctx) => open(ctx) });
}
