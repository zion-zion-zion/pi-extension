#!/usr/bin/env node
/**
 * 一致性检查 / 对齐：仓库里的产物 vs pi 实际加载的路径。
 *
 * 设计文档：docs/superpowers/specs/2026-09-14-restart-design.md（「架构」一节）
 *
 * 为什么需要它：光靠文档约定「一律软链」会漂移 —— `cp` 出来的是一份拷贝，改仓库不生效，
 * 两边静默分叉。这个脚本把约定变成**可检查的事实**：清单（下面的 ITEMS）是唯一权威列表，
 * AGENTS.md 只指向它，不重复维护。
 *
 * 用法：
 *   node scripts/link.mjs          # 只检查，非 0 退出 = 有需要处理的项
 *   node scripts/link.mjs --fix    # 把「拷贝一致 / 缺失」收敛成软链；漂移项只报告
 *
 * 漂移项**故意不自动修**：方向不一定是仓库新。`pi-footer.json` / `pi-context-view.json`
 * 这类运行时可被 UI 改写的配置，本地可能才更新 —— 自动覆盖会丢东西。先看清 diff 再决定
 * 往哪边搬，然后重跑 --fix。
 *
 * 用 Node 而不是 bash：node 是 pi 的运行时，必然存在；也省掉 macOS bash 3.2 里
 * `readlink -f` / `realpath` 缺失的坑。
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REPO = realpathSync(join(import.meta.dirname, ".."));
const EXT_DIR = join(homedir(), ".pi", "agent", "extensions");
const SKILLS_DIR = join(homedir(), ".agents", "skills");

/**
 * 权威清单：仓库里的源 → pi 加载的位置。新增扩展 / 配置 / skill 时在这里加一行。
 * dest 一律写成软链，指向 src。
 */
const ITEMS = [
	// 单文件扩展
	{ src: "extensions/auto-hide-thinking.ts", dest: join(EXT_DIR, "auto-hide-thinking.ts") },
	{ src: "extensions/scroll-to-last-prompt.ts", dest: join(EXT_DIR, "scroll-to-last-prompt.ts") },
	{ src: "extensions/model-filter.ts", dest: join(EXT_DIR, "model-filter.ts") },
	{ src: "extensions/restart.ts", dest: join(EXT_DIR, "restart.ts") },
	{ src: "extensions/herdr-session-title.ts", dest: join(EXT_DIR, "herdr-session-title.ts") },
	{ src: "extensions/commits.ts", dest: join(EXT_DIR, "commits.ts") },
	{ src: "extensions/checkpoint.ts", dest: join(EXT_DIR, "checkpoint.ts") },
	{ src: "extensions/steer-or-interrupt.ts", dest: join(EXT_DIR, "steer-or-interrupt.ts") },
	{ src: "extensions/token-speed.ts", dest: join(EXT_DIR, "token-speed.ts") },
	// 目录型扩展
	{ src: "extensions/reload-all", dest: join(EXT_DIR, "reload-all") },
	{ src: "extensions/codex-usage", dest: join(EXT_DIR, "codex-usage") },
	// 运行时会被扩展改写的配置（写盘必须是 writeFile，不能是「写临时文件 + rename」，
	// 否则 rename 会把软链替换成真实文件、软链静默失效）
	{ src: "extensions/pi-footer.json", dest: join(EXT_DIR, "pi-footer.json") },
	{ src: "extensions/pi-context-view.json", dest: join(EXT_DIR, "pi-context-view.json") },
	// skills
	{ src: "skills/read-terminal", dest: join(SKILLS_DIR, "read-terminal") },
];

/** 故意不安装到本机（检查时只作提示，不算问题）。 */
const NOT_INSTALLED = [
	{ src: "extensions/startup-sync.ts", reason: "与本机 scripts/backup.sh 强耦合，按需手动安装" },
];

/** pi 目录里这些**不属于**本仓库，永远不要软链进来。 */
const NOT_OURS = [
	"herdr-agent-state.ts（herdr 安装/升级会覆盖）",
	"~/.pi/agent/settings.json、models.json、auth.json（机器/个人数据）",
	"~/.pi/agent/npm/**（settings.json 里 packages 安装的 npm 包）",
];

function sameContent(a, b) {
	try {
		execFileSync("diff", ["-rq", a, b], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function realOrNull(path) {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** 单个产物的状态。 */
function classify(item) {
	const src = join(REPO, item.src);
	if (!existsSync(src)) return { kind: "missing-src" };

	if (!existsSync(item.dest)) {
		// 可能是断链（existsSync 对断链返回 false），也可能是真的没有
		const lst = lstatSync(item.dest, { throwIfNoEntry: false });
		return { kind: lst?.isSymbolicLink() ? "broken-link" : "missing" };
	}

	const lst = lstatSync(item.dest);
	if (lst.isSymbolicLink()) {
		const target = realOrNull(item.dest);
		if (target === null) return { kind: "broken-link" };
		return target === realpathSync(src) ? { kind: "ok" } : { kind: "wrong-target", target };
	}

	return sameContent(src, item.dest) ? { kind: "copy-ok" } : { kind: "drift" };
}

const LABEL = {
	ok: "✅ 软链正确",
	"copy-ok": "▪️  拷贝（内容一致，可 --fix 收敛成软链）",
	drift: "❌ 漂移（两边内容不同，先判方向）",
	"wrong-target": "❌ 软链指向别处",
	"broken-link": "❌ 断链",
	missing: "❌ 缺失（pi 没在加载它）",
	"missing-src": "❌ 仓库里没有这个源文件（清单要更新）",
};

const FIXABLE = new Set(["copy-ok", "missing"]);

function rel(path) {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function printDiff(item) {
	const src = join(REPO, item.src);
	console.log(`     仓库: ${item.src}`);
	console.log(`     本地: ${rel(item.dest)}`);
	try {
		const out = execFileSync("diff", ["-rq", src, item.dest], { encoding: "utf8", stdio: "pipe" });
		if (out.trim()) console.log(`     ${out.trim().split("\n").slice(0, 4).join("\n     ")}`);
	} catch (error) {
		const text = String(error.stdout ?? "").trim();
		for (const line of text.split("\n").slice(0, 4)) {
			if (line.trim()) console.log(`     ${line.trim()}`);
		}
	}
	console.log("     → 建议：把较新的那份搬到另一边（cp），再重跑 --fix");
}

/**
 * 反向稽核：仓库里出现了清单没写的新产物时报警。
 *
 * 这台机器上经常同时开着好几个 pi 窗口写这个仓库，新扩展是被别人加进来的 —— 清单靠人记得
 * 更新就会过期，所以让脚本自己发现它（不在 ITEMS / NOT_INSTALLED 里就算问题）。
 */
function auditList() {
	const known = new Set([...ITEMS, ...NOT_INSTALLED].map((item) => item.src));
	const unknown = [];

	for (const [dir, prefix] of [
		[join(REPO, "extensions"), "extensions"],
		[join(REPO, "skills"), "skills"],
	]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".")) continue;
			const path = `${prefix}/${name}`;
			if (!known.has(path)) unknown.push(path);
		}
	}
	return unknown;
}

function main() {
	const fix = process.argv.includes("--fix");
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log("用法: node scripts/link.mjs [--fix]");
		console.log("  （无参数）只检查；--fix 把「拷贝一致 / 缺失」收敛成软链");
		return 0;
	}

	console.log(`仓库: ${REPO}\n`);
	let problems = 0;
	let fixed = 0;

	for (const item of ITEMS) {
		let status = classify(item);
		const name = item.src;

		if (fix && FIXABLE.has(status.kind)) {
			const src = join(REPO, item.src);
			mkdirSync(dirname(item.dest), { recursive: true });
			rmSync(item.dest, { recursive: true, force: true });
			symlinkSync(src, item.dest);
			fixed += 1;
			console.log(`🔧 ${name}  已换成软链（原状态：${status.kind}）`);
			status = classify(item);
		}

		const problem = status.kind !== "ok" && status.kind !== "copy-ok";
		if (problem) problems += 1;
		console.log(`${LABEL[status.kind]}  ${name}`);
		if (status.kind === "drift" || status.kind === "wrong-target") printDiff(item);
		if (status.kind === "wrong-target") console.log(`     软链当前指向: ${status.target}`);
	}

	const unknown = auditList();
	if (unknown.length > 0) {
		problems += unknown.length;
		console.log("\n⚠️  仓库里有产物没进清单（新加的就在 ITEMS 里补一行）：");
		for (const path of unknown) console.log(`  • ${path}`);
	}

	if (NOT_INSTALLED.length > 0) {
		console.log("\n（本机故意不安装）");
		for (const item of NOT_INSTALLED) console.log(`  ⏭️  ${item.src} —— ${item.reason}`);
	}

	console.log("\n（这些不属于本仓库，别软链进来）");
	for (const line of NOT_OURS) console.log(`  🚫 ${line}`);

	const total = problems + unknown.length;
	const detail = unknown.length > 0 ? `（漂移/缺失 ${problems}；未进清单 ${unknown.length}）` : "";
	console.log(
		`\n合计 ${ITEMS.length} 项：需处理 ${total}${detail}${fixed > 0 ? `（本次已修 ${fixed}）` : ""}`,
	);
	if (problems > 0 && !fix) console.log("  → 漂移/缺失：`node scripts/link.mjs --fix` 可收敛「拷贝一致 / 缺失」");
	if (unknown.length > 0) console.log("  → 未进清单：在 scripts/link.mjs 的 ITEMS 里补一行（或添到 NOT_INSTALLED）");
	return total > 0 ? 1 : 0;
}

process.exit(main());
