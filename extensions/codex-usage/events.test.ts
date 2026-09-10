import assert from "node:assert/strict";
import { test } from "node:test";
import { isCodexAssistantMessage, shouldShowCodexUsage } from "./events.ts";

test("auto-refresh only follows openai-codex assistant turns", () => {
	assert.equal(isCodexAssistantMessage({ role: "assistant", provider: "openai-codex" }), true);
	assert.equal(isCodexAssistantMessage({ role: "assistant", provider: "anthropic" }), false);
	assert.equal(isCodexAssistantMessage({ role: "user", provider: "openai-codex" }), false);
	assert.equal(isCodexAssistantMessage(undefined), false);
});

test("footer usage is shown only for an OAuth openai-codex model", () => {
	assert.equal(
		shouldShowCodexUsage({
			model: { provider: "openai-codex" },
			isUsingOAuth: true,
		}),
		true,
	);
	assert.equal(
		shouldShowCodexUsage({
			model: { provider: "openai-codex" },
			isUsingOAuth: false,
		}),
		false,
	);
	assert.equal(
		shouldShowCodexUsage({
			model: { provider: "01" },
			isUsingOAuth: true,
		}),
		false,
	);
	assert.equal(shouldShowCodexUsage({ model: undefined, isUsingOAuth: true }), false);
});
