import assert from "node:assert/strict";
import test from "node:test";

import { modelLabel } from "./index.ts";

test("custom aliases win over the models.json name", () => {
	assert.equal(modelLabel({ provider: "magpie", id: "codex/gpt-6.1-sol", name: "GPT-6.1 Sol · Codex" }), "奥特曼");
	assert.equal(modelLabel({ provider: "magpie", id: "codex/gpt-6.1-terra", name: "GPT-6.1 Terra · Codex" }), "O畜");
	assert.equal(modelLabel({ provider: "magpie", id: "aigw/gpt-6.1-sol" }), "盗版O社");
	assert.equal(modelLabel({ provider: "magpie", id: "aigw/deepseek-flash" }), "梁圣");
	assert.equal(modelLabel({ provider: "magpie", id: "aigw/grok-4.7" }), "宝马");
	assert.equal(modelLabel({ provider: "magpie", id: "aigw/k3.1-pro-highspeed" }), "月亮之上");
	assert.equal(modelLabel({ provider: "magpie", id: "01ai-tokenhub/grok-4.7-build-fast" }), "汗血宝马");
});

test("drops the source suffix from models.json names", () => {
	assert.equal(modelLabel({ provider: "magpie", id: "auto/gpt-6.1-terra", name: "GPT-6.1 Terra · routing group" }), "GPT-6.1 Terra");
	assert.equal(
		modelLabel({ provider: "magpie", id: "01ai-tokenhub/grok-4.7", name: "Grok 4.7 · 01ai-tokenhub" }),
		"Grok 4.7",
	);
});

test("keeps a name that has no source suffix", () => {
	assert.equal(modelLabel({ provider: "magpie", id: "x", name: "Plain Name" }), "Plain Name");
});

test("falls back to the id when there is no name", () => {
	assert.equal(modelLabel({ provider: "magpie", id: "auto/gpt-6.1-sol" }), "auto/gpt-6.1-sol");
	assert.equal(modelLabel({ provider: "magpie", id: "auto/gpt-6.1-sol", name: "   " }), "auto/gpt-6.1-sol");
});

test("returns nothing when no model is selected", () => {
	assert.equal(modelLabel(undefined), null);
	assert.equal(modelLabel(null), null);
	assert.equal(modelLabel({ provider: "magpie" }), null);
});
