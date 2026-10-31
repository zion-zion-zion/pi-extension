import assert from "node:assert/strict";
import { test } from "node:test";
import { accountLabel, activeAccount, parseQuotasResponse, QuotaError, shortLabel, showsSubscriptionQuota } from "./parser.ts";

const FETCHED_AT = Date.parse("2026-10-30T12:40:00+08:00");

const payload = {
	object: "list",
	data: [
		{
			provider: "codex",
			plan: "team",
			user: "zhoujie@01.ai · Team",
			last: true,
			windows: [
				{ name: "5 hours", used: 17, remaining: 83, resetsAt: "2026-10-30T16:36:59+08:00" },
				{ name: "7 days", used: 50, remaining: 50, resetsAt: "2026-11-04T14:39:59+08:00" },
			],
			readAt: "2026-10-30T12:36:34.445156+08:00",
		},
		{
			provider: "codex",
			plan: "plus",
			user: "jiezhougpt@gmail.com",
			windows: [
				{ name: "5 hours", used: 0, remaining: 100, resetsAt: "2026-10-30T17:36:33+08:00" },
				{ name: "7 days", used: 14, remaining: 86, resetsAt: "2026-11-04T16:54:31+08:00" },
			],
		},
	],
};

test("parses both subscription accounts and their windows", () => {
	const snapshot = parseQuotasResponse(payload, FETCHED_AT);
	assert.equal(snapshot.fetchedAt, FETCHED_AT);
	assert.equal(snapshot.accounts.length, 2);

	const team = snapshot.accounts[0];
	assert.equal(team?.user, "zhoujie@01.ai · Team");
	assert.equal(team?.plan, "team");
	assert.deepEqual(
		team?.windows.map((window) => [window.label, window.remaining]),
		[
			["5h", 83],
			["7d", 50],
		],
	);
	assert.equal(team?.windows[0]?.resetsAt, Date.parse("2026-10-30T16:36:59+08:00"));

	const plus = snapshot.accounts[1];
	assert.equal(plus?.windows[1]?.remaining, 86);
	assert.equal(plus?.readAt, undefined);
});

test("shortens window names and account labels", () => {
	assert.equal(shortLabel("5 hours"), "5h");
	assert.equal(shortLabel("7 days"), "7d");
	assert.equal(shortLabel("session"), "session");

	const snapshot = parseQuotasResponse(payload, FETCHED_AT);
	assert.equal(accountLabel(snapshot.accounts[0]!), "Team");
	assert.equal(accountLabel(snapshot.accounts[1]!), "jiezhougpt");
});

test("rejects a payload without usable accounts", () => {
	assert.throws(() => parseQuotasResponse({ data: [] }, FETCHED_AT), QuotaError);
	assert.throws(() => parseQuotasResponse({ nope: true }, FETCHED_AT), QuotaError);
	assert.throws(
		() => parseQuotasResponse({ data: [{ user: "a@b.c", windows: [{ name: "5 hours" }] }] }, FETCHED_AT),
		QuotaError,
	);
});

test("the account magpie marks last is the one in use", () => {
	const snapshot = parseQuotasResponse(payload, FETCHED_AT);
	assert.equal(snapshot.accounts[0]?.last, true);
	assert.equal(snapshot.accounts[1]?.last, false);
	assert.equal(activeAccount(snapshot)?.user, "zhoujie@01.ai · Team");
});

test("without a last mark, the first account stands in", () => {
	const snapshot = parseQuotasResponse(
		{ data: [{ user: "only@example.com", windows: [{ name: "5 hours", remaining: 40 }] }] },
		FETCHED_AT,
	);
	assert.equal(activeAccount(snapshot)?.user, "only@example.com");
});

test("footer only watches magpie gpt subscriptions", () => {
	assert.equal(showsSubscriptionQuota({ provider: "magpie", id: "auto/gpt-6.1-sol" }), true);
	assert.equal(showsSubscriptionQuota({ provider: "magpie", id: "auto/gpt-6.1-terra" }), true);
	assert.equal(showsSubscriptionQuota({ provider: "magpie", id: "codex/gpt-6.1-sol" }), true);
	assert.equal(showsSubscriptionQuota({ provider: "magpie", id: "01ai-tokenhub/gpt-6.1-sol" }), false);
	assert.equal(showsSubscriptionQuota({ provider: "magpie", id: "01ai-tokenhub/grok-4.7-build-fast" }), false);
	assert.equal(showsSubscriptionQuota({ provider: "openai-codex", id: "gpt-5.5" }), false);
	assert.equal(showsSubscriptionQuota(undefined), false);
});

test("clamps out-of-range remaining and skips nameless windows", () => {
	const snapshot = parseQuotasResponse(
		{
			data: [
				{
					user: "only@example.com",
					windows: [
						{ name: "5 hours", remaining: 140 },
						{ name: "", remaining: 10 },
						{ remaining: 10 },
					],
				},
			],
		},
		FETCHED_AT,
	);
	assert.equal(snapshot.accounts[0]?.windows.length, 1);
	assert.equal(snapshot.accounts[0]?.windows[0]?.remaining, 100);
});
