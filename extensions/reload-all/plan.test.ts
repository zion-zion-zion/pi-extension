import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPane, isSkipReason, REASON_LABEL, type Pane } from "./plan.ts";

const SELF = "w5:pC";

function pane(overrides: Partial<Pane> = {}): Pane {
	return {
		paneId: "w5:p7",
		agent: "pi",
		agentStatus: "idle",
		cwd: "pi-extension",
		tabId: "w5:t7",
		workspaceId: "w5",
		sessionRef: "/Users/jiezhou/.pi/agent/sessions/--x--/s.jsonl",
		...overrides,
	};
}

test("正常目标：空闲 + 空输入框 + 有会话记录", () => {
	assert.deepEqual(classifyPane(pane(), SELF, true, "empty"), { kind: "target" });
	assert.deepEqual(classifyPane(pane(), SELF, false, "empty"), { kind: "target" });
});

test("不是 pi 的窗口 / 没有 pane id / 就是自己 → ignore（连通告都不进）", () => {
	assert.deepEqual(classifyPane(pane({ agent: "" }), SELF, true, "empty"), { kind: "ignore" });
	assert.deepEqual(classifyPane(pane({ agent: "codex" }), SELF, true, "empty"), { kind: "ignore" });
	assert.deepEqual(classifyPane(pane({ paneId: "" }), SELF, true, "empty"), { kind: "ignore" });
	assert.deepEqual(classifyPane(pane({ paneId: SELF }), SELF, true, "empty"), { kind: "ignore" });
});

test("忙碌（working/blocked/done）→ 跳过，且不必读屏幕", () => {
	for (const status of ["working", "blocked", "done"]) {
		assert.deepEqual(classifyPane(pane({ agentStatus: status }), SELF, true, "unread"), {
			kind: "skip",
			reason: "busy",
		});
	}
});

test("要恢复会话但没有会话记录 → no-session（`/restart-all` 的独有跳过项）", () => {
	assert.deepEqual(classifyPane(pane({ sessionRef: "" }), SELF, true, "unread"), {
		kind: "skip",
		reason: "no-session",
	});
	// `/reload-all` 不关心会话，同样条件下应该继续往下走。
	assert.deepEqual(classifyPane(pane({ sessionRef: "" }), SELF, false, "unread"), { kind: "need-editor" });
});

test("还没读屏幕的合格窗口 → need-editor", () => {
	assert.deepEqual(classifyPane(pane(), SELF, true, "unread"), { kind: "need-editor" });
	assert.deepEqual(classifyPane(pane(), SELF, false, "unread"), { kind: "need-editor" });
});

test("有草稿 → draft；读不到屏幕 → unconfirmed（失败安全：宁可漏发）", () => {
	assert.deepEqual(classifyPane(pane(), SELF, true, "occupied"), { kind: "skip", reason: "draft" });
	assert.deepEqual(classifyPane(pane(), SELF, true, "unknown"), { kind: "skip", reason: "unconfirmed" });
});

test("每一种跳过原因都有中文文案；isSkipReason 只认已知值", () => {
	for (const reason of ["busy", "draft", "unconfirmed", "no-session"] as const) {
		assert.equal(typeof REASON_LABEL[reason], "string");
		assert.ok(REASON_LABEL[reason].length > 0);
		assert.ok(isSkipReason(reason));
	}
	assert.equal(isSkipReason("whatever"), false);
	assert.equal(isSkipReason(""), false);
});
