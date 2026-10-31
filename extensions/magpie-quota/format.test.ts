import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCard, formatFooter, formatResetRemaining, quotaColor } from "./format.ts";
import type { QuotaSnapshot } from "./parser.ts";

const NOW = Date.parse("2026-10-30T12:40:00+08:00");

const snapshot: QuotaSnapshot = {
	fetchedAt: NOW,
	accounts: [
		{
			user: "zhoujie@01.ai · Team",
			plan: "team",
			last: true,
			windows: [
				{ label: "5h", remaining: 83, resetsAt: Date.parse("2026-10-30T16:36:59+08:00") },
				{ label: "7d", remaining: 50, resetsAt: Date.parse("2026-11-04T14:39:59+08:00") },
			],
		},
		{
			user: "jiezhougpt@gmail.com",
			plan: "plus",
			last: false,
			windows: [
				{ label: "5h", remaining: 100, resetsAt: Date.parse("2026-10-30T17:36:33+08:00") },
				{ label: "7d", remaining: 8, resetsAt: NOW + 20 * 60_000 },
			],
		},
	],
};

test("footer shows only the account magpie last served", () => {
	assert.equal(formatFooter(snapshot), "Team 5h 83% · 7d 50%");
});

test("colors the percent by how much remains", () => {
	const paint = {
		green: (text: string) => `[g]${text}`,
		yellow: (text: string) => `[y]${text}`,
		orange: (text: string) => `[o]${text}`,
		red: (text: string) => `[r]${text}`,
	};
	assert.equal(quotaColor(83), "green");
	assert.equal(quotaColor(50), "green");
	assert.equal(quotaColor(25), "yellow");
	assert.equal(quotaColor(10), "orange");
	assert.equal(quotaColor(9), "red");
	assert.equal(formatFooter(snapshot, { paint }), "Team 5h [g]83% · 7d [g]50%");
});

test("marks a stale footer", () => {
	assert.match(formatFooter(snapshot, { stale: true }) ?? "", /⚠$/);
});

test("card lines include the reset countdown", () => {
	const lines = formatCard(snapshot, NOW, false);
	assert.match(lines[0] ?? "", /zhoujie@01\.ai · Team · team/);
	assert.match(lines[0] ?? "", /5h 83%（3小时56分后重置）/);
	assert.match(lines[0] ?? "", /7d 50%（5天1小时后重置）/);
	assert.match(lines[1] ?? "", /7d 8%（20分后重置）/);
	assert.equal(lines[2], "刚刚更新");
});

test("reset remaining collapses to the coarsest useful unit", () => {
	assert.equal(formatResetRemaining(NOW + (2 * 60 + 14) * 60_000, NOW), "2小时14分");
	assert.equal(formatResetRemaining(NOW + 3 * 24 * 60 * 60_000, NOW), "3天");
	assert.equal(formatResetRemaining(NOW - 60_000, NOW), "已重置");
	assert.equal(formatResetRemaining(undefined, NOW), undefined);
});
