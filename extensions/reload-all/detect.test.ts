import assert from "node:assert/strict";
import { test } from "node:test";
import { detectEditorState } from "./detect.ts";

const RULE = "─".repeat(60);

/** 实测的空 footer（末尾两行），见设计文档「技术依据 F」。 */
const FOOTER = [
	"🤖 01/grok-4.6-latest • 🧠 high • 🔢 ↑306k ↓7k • 📖 1.1m • 🎯 99.7% • 💸 $0.0000 • 📊 ▓░░░░░░░░░ 71k/1m (7%)",
	"📈 (+0,-0) • ⏳ 94h",
];

function screen(...body: string[]): string {
	return [...body, ...FOOTER].join("\n");
}

test("空输入框 → empty（4 个 pane 的实测形态）", () => {
	assert.equal(detectEditorState(screen("是的，之前被我们盖住了。", "", RULE, "", RULE)), "empty");
});

test("只有空白的输入框 → empty", () => {
	assert.equal(detectEditorState(screen(RULE, "   ", RULE)), "empty");
});

test("单行草稿 → occupied", () => {
	assert.equal(detectEditorState(screen("上一段回答", "", RULE, "帮我看看这个", RULE)), "occupied");
});

test("多行草稿 → occupied", () => {
	assert.equal(detectEditorState(screen(RULE, "第一行草稿", "第二行草稿", RULE)), "occupied");
});

test("草稿里含整行长横线，仍判 occupied", () => {
	// 从下往上找会先把「草稿继续」上方的横线当上边线，但结论不受影响。
	assert.equal(
		detectEditorState(screen(RULE, "草稿开始", "─".repeat(40), "草稿继续", RULE)),
		"occupied",
	);
});

test("对话正文里的长分隔线不能当成边线", () => {
	assert.equal(detectEditorState(screen("对话上半", RULE, "对话下半", RULE, "", RULE)), "empty");
});

test("横线不足两条 → unknown", () => {
	assert.equal(detectEditorState(screen("只有对话", "没有边线")), "unknown");
});

test("下边线离屏幕底部过远 → unknown", () => {
	assert.equal(detectEditorState(screen(RULE, "", RULE, "a", "b", "c", "d", "e", "f")), "unknown");
});

test("补全弹窗打开时的真实草稿（w5:p7 实测形态）→ occupied", () => {
	// 下边线之后有 4 行：补全项 + 2 行 footer + 1 行额外状态栏。
	const real = [
		"",
		RULE,
		"/wechat",
		RULE,
		"→ wechat      [u:npm:pi-wechat-assistant] 微信桥接管理：login | start | stop | status | config | logout | autostart | remotetools",
		"🤖 01/deepseek-v4.1-flash • 🧠 high • 🔢 ↑0 ↓0 • 💸 $0.0000 • 📊 ░░░░░░░░░░ 0/1m (0%) • 🧩 0%",
		"🌿 main • 🔖 8ea6e31 • 🔀 +0 ±2 ?1 • 📈 (+73,-4) • ↕️ ↑2 ↓0 • ⏳ 0m",
		"[微信 ⏸ 未连接]",
	].join("\n");
	assert.equal(detectEditorState(real), "occupied");
});

test("尾部行数在上限内 → empty", () => {
	// 下边线之后 4 + 2 = 6 行，正好在上限上。
	assert.equal(detectEditorState(screen(RULE, "", RULE, "a", "b", "c", "d")), "empty");
});

test("尾部行数刚超上限 → unknown", () => {
	assert.equal(detectEditorState(screen(RULE, "", RULE, "a", "b", "c", "d", "e")), "unknown");
});

test("末尾空行不影响判定", () => {
	assert.equal(detectEditorState(`${screen("对话", "", RULE, "", RULE)}\n\n  \n`), "empty");
});

test("空屏幕 → unknown", () => {
	assert.equal(detectEditorState(""), "unknown");
});
