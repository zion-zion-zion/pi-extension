/**
 * `/restart` —— 重启本窗口：换进程、回到同一个对话。
 *
 * 设计文档：docs/superpowers/specs/2026-09-14-restart-design.md
 *
 * 与 `/reload` 的分工：`/reload` 只替换扩展代码、**不换进程**，清不掉内存里被污染的 prototype
 * 包装器（2026-09-14 auto-hide-thinking 的爆栈事故就是这一类）；`/restart` 换进程，能清干净。
 * 而 pi 没有内置的「重启进程」命令，所以这里用「分离助手」在自己退出之后再把 pi 拉起来：
 *
 *   1. spawn 一个 detached 的 /bin/sh 助手（进程外，活得过我退出）
 *   2. ctx.shutdown() 干净退出（会话已存盘）
 *   3. 助手等本窗口的 pi 进程消失，并确认前台已经不是 pi
 *   4. 助手执行 herdr pane run <本窗口> 'pi --session "<刚才那个会话文件>"'
 *
 * 助手不是 pi：不加载模型、不碰任何会话，只活几秒，输出追加到 ~/.pi/agent/restart.log。
 *
 * 本文件刻意不 import 本仓库的其他扩展（实测过：`reload-all` 反向依赖它会让没装 restart.ts 的
 * 窗口整个起不来）。批量那一路 `/restart-all` 用的是同一套四步的 TS 版，在
 * `extensions/reload-all/restart-pane.ts`；两份实现的存在理由与同步要求见设计文档「架构」。
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PANE_ID = process.env.HERDR_PANE_ID ?? "";
const ENABLED = process.env.HERDR_ENV === "1" && PANE_ID !== "";
const LOG_PATH = join(getAgentDir(), "restart.log");
/** 助手启动的确认窗口：`spawn` 事件不到就当作失败（绝不带着一个没起来的助手退出）。 */
const HELPER_SPAWN_TIMEOUT_MS = 2_000;

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 助手脚本。参数全部走环境变量，避免往命令行里拼字符串。
 *
 * 两段等待是刻意的双保险：先等自己的 pid 消失（快），再用 herdr 确认前台不是 pi（权威）——
 * 只有后者说「不是 pi」了，才注入 `pi`。
 */
const HELPER_SCRIPT = `
exec >>"$RESTART_LOG" 2>&1
echo "[$(date '+%H:%M:%S')] helper start pi_pid=$PI_PID pane=$PANE_ID"
i=0
while [ $i -lt 200 ]; do
  kill -0 "$PI_PID" 2>/dev/null || break
  sleep 0.1
  i=$((i+1))
done
sleep 0.5
i=0
while [ $i -lt 50 ]; do
  herdr pane process-info --pane "$PANE_ID" 2>/dev/null | grep -q '"argv0":"pi"' || break
  sleep 0.1
  i=$((i+1))
done
echo "[$(date '+%H:%M:%S')] relaunch: pi --session $SESSION_FILE"
herdr pane run "$PANE_ID" "pi --session \\"$SESSION_FILE\\""
echo "[$(date '+%H:%M:%S')] helper done exit=$?"
`;

/** 起一个分离助手；等到 `spawn` 事件才算成功（否则调用方必须放弃退出）。 */
async function spawnRestartHelper(sessionRef: string): Promise<void> {
	const child = spawn("/bin/sh", ["-c", HELPER_SCRIPT], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			RESTART_LOG: LOG_PATH,
			PI_PID: String(process.pid),
			PANE_ID,
			SESSION_FILE: sessionRef,
		},
	});
	child.unref();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("助手启动超时")), HELPER_SPAWN_TIMEOUT_MS);
		child.once("spawn", () => {
			clearTimeout(timer);
			resolve();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("restart", {
		description: "重启本窗口（换进程，回到同一个对话）",
		handler: async (_args, ctx) => {
			if (!ENABLED) {
				ctx.ui.notify("/restart 只在 Herdr 窗口里可用（HERDR_ENV !== 1），未做任何操作。", "error");
				return;
			}
			const sessionRef = ctx.sessionManager.getSessionFile();
			if (typeof sessionRef !== "string" || sessionRef === "") {
				ctx.ui.notify("/restart 拿不到本窗口的会话文件，已放弃（不会用新对话顶替）。", "error");
				return;
			}
			// 别打断进行中的回合。
			await ctx.waitForIdle();
			try {
				await spawnRestartHelper(sessionRef);
			} catch (error) {
				try {
					appendFileSync(LOG_PATH, `[restart] 助手启动失败：${errText(error)}\n`);
				} catch {
					// 日志写不进去也不能影响主流程。
				}
				ctx.ui.notify(`/restart 重启助手没能启动，已取消：${errText(error)}`, "error");
				return;
			}
			ctx.ui.notify("正在重启本窗口…", "info");
			ctx.shutdown();
			return;
		},
	});
}
