import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuotaStore, describeQuotaError } from "./client.ts";
import { QuotaError } from "./parser.ts";

const payload = {
	data: [
		{
			user: "zhoujie@01.ai · Team",
			plan: "team",
			windows: [{ name: "5 hours", remaining: 83, resetsAt: "2026-10-30T16:36:59+08:00" }],
		},
	],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("refresh parses a quotas response and keeps it", async () => {
	const store = createQuotaStore({
		now: () => 1000,
		fetchImpl: async () => jsonResponse(payload),
	});
	const snapshot = await store.refresh();
	assert.equal(snapshot.accounts[0]?.windows[0]?.remaining, 83);
	assert.equal(store.snapshot(), snapshot);
	assert.equal(store.stale(), false);
});

test("a failed refresh keeps the previous snapshot and marks it stale", async () => {
	let calls = 0;
	const store = createQuotaStore({
		now: () => 1000,
		fetchImpl: async () => {
			calls += 1;
			if (calls === 1) return jsonResponse(payload);
			return jsonResponse({ error: "nope" }, 500);
		},
	});
	const first = await store.refresh();
	await assert.rejects(store.refresh(), (error: unknown) => {
		assert.ok(error instanceof QuotaError);
		assert.equal(error.code, "http_error");
		assert.equal(error.status, 500);
		return true;
	});
	assert.equal(store.snapshot(), first);
	assert.equal(store.stale(), true);
});

test("connection refusal is reported as unreachable", async () => {
	const store = createQuotaStore({
		fetchImpl: async () => {
			throw new TypeError("fetch failed");
		},
	});
	await assert.rejects(store.refresh(), (error: unknown) => {
		assert.ok(error instanceof QuotaError);
		assert.equal(error.code, "unreachable");
		assert.match(describeQuotaError(error), /magpie/);
		return true;
	});
	assert.equal(store.snapshot(), undefined);
});

test("overlapping refreshes share one request", async () => {
	let calls = 0;
	const store = createQuotaStore({
		fetchImpl: async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return jsonResponse(payload);
		},
	});
	const [a, b] = await Promise.all([store.refresh(), store.refresh()]);
	assert.equal(a, b);
	assert.equal(calls, 1);
});
