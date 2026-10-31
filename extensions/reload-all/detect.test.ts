import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { detectEditorState } from "./detect.ts";

const TOP = `╭${"─".repeat(60)}╮`;
const BOTTOM = `╰${"─".repeat(60)}╯`;
const BLANK = `│${" ".repeat(60)}│`;

/** 实测的 footer（圆角框之后的一行）。 */
const FOOTER = "✦ 01/deepseek-v4.1-flash • 🧠 max • 206.7k/1M (21%) • ⚡200 tok/s • MCP 0/1";

/** pretty-tui 左右各留约 12% 的缩进。 */
const INDENT = " ".repeat(21);

function screen(...body: string[]): string {
	return [...body, FOOTER].map((line) => (line === "" ? "" : INDENT + line)).join("\n");
}

test("空输入框 → empty", () => {
	assert.equal(detectEditorState(screen("是的，之前被我们盖住了。", "", TOP, BLANK, BOTTOM)), "empty");
});

test("只有空白的输入框 → empty", () => {
	assert.equal(detectEditorState(screen(TOP, `│${" ".repeat(60)}│`, BOTTOM)), "empty");
});

test("单行草稿 → occupied", () => {
	const draft = `│${"帮我看看这个".padEnd(60, " ")}│`;
	assert.equal(detectEditorState(screen("上一段回答", "", TOP, draft, BOTTOM)), "occupied");
});

test("多行草稿 → occupied", () => {
	const first = `│${"第一行草稿".padEnd(60, " ")}│`;
	const second = `│${"第二行草稿".padEnd(60, " ")}│`;
	assert.equal(detectEditorState(screen(TOP, first, second, BOTTOM)), "occupied");
});

test("对话正文里的横线和圆角框不能当成输入框", () => {
	const decoy = `── ✓ Completed in 33s ${"─".repeat(30)} [Copy] ──`;
	assert.equal(detectEditorState(screen("对话上半", decoy, "对话下半", TOP, BLANK, BOTTOM)), "empty");
});

test("找不到圆角框 → unknown", () => {
	assert.equal(detectEditorState(screen("只有对话", "没有边框")), "unknown");
});

test("底边离屏幕底部过远 → unknown", () => {
	assert.equal(
		detectEditorState(screen(TOP, BLANK, BOTTOM, "a", "b", "c", "d", "e", "f", "g")),
		"unknown",
	);
});

test("只有顶边没有底边 → unknown", () => {
	assert.equal(detectEditorState(screen(TOP, BLANK, FOOTER)), "unknown");
});

test("框不完整（内容行缺竖线）→ unknown", () => {
	assert.equal(detectEditorState(screen(TOP, "普通文本", BOTTOM)), "unknown");
});

test("末尾空行不影响判定", () => {
	assert.equal(detectEditorState(`${screen(TOP, BLANK, BOTTOM)}\n\n  \n`), "empty");
});

test("空屏幕 → unknown", () => {
	assert.equal(detectEditorState(""), "unknown");
});

/** 2026-10-30 从真实窗口截下的屏幕，圆角框带左右缩进。 */
function fixture(name: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return readFileSync(join(here, "fixtures", name), "utf8");
}

test("真实屏幕：空输入框 → empty", () => {
	assert.equal(detectEditorState(fixture("empty-editor.txt")), "empty");
});

test("真实屏幕：输入框里有草稿 → occupied", () => {
	assert.equal(detectEditorState(fixture("draft-editor.txt")), "occupied");
});

test("真实屏幕：上方有更新提示框 → empty", () => {
	// 提示框用整行 ─ 画边，不能被误认成输入框。
	assert.equal(detectEditorState(fixture("update-notice.txt")), "empty");
});
