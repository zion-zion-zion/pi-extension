import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatResetRemaining,
	formatStatusBar,
	formatStatusCard,
	quotaColor,
	remainingPercent,
} from "./format.ts";
import type { UsageSnapshot } from "./parser.ts";

const NOW = 1_700_000_000_000;

const snapshot: UsageSnapshot = {
	planType: "Pro",
	fetchedAt: NOW,
	fiveHour: {
		usedPercent: 32,
		resetAt: NOW + (2 * 60 + 14) * 60_000,
		windowMinutes: 300,
	},
	weekly: {
		usedPercent: 61,
		resetAt: NOW + (3 * 24 + 8) * 60 * 60_000,
		windowMinutes: 10_080,
	},
};

test("remaining percent is clamped from used percent", () => {
	assert.equal(remainingPercent(32), 68);
	assert.equal(remainingPercent(0), 100);
	assert.equal(remainingPercent(100), 0);
});

test("formats reset remaining as hours, days, or expired", () => {
	assert.equal(formatResetRemaining(NOW + (2 * 60 + 14) * 60_000, NOW), "2h14m");
	assert.equal(formatResetRemaining(NOW + (3 * 24 + 8) * 60 * 60_000, NOW), "3d8h");
	assert.equal(formatResetRemaining(NOW - 60_000, NOW), "expired");
	assert.equal(formatResetRemaining(undefined, NOW), undefined);
});

test("renders a wide single-line status card with 10-cell remaining bars", () => {
	const lines = formatStatusCard(snapshot, { width: 120, now: NOW, stale: false });
	assert.equal(lines.length, 1);
	assert.equal(
		lines[0],
		"Codex · Pro   5h ███████░░░ 68% · 2h14m   │   Week ████░░░░░░ 39% · 3d8h   · now",
	);
});

test("shortens bars to 5 cells before wrapping", () => {
	const lines = formatStatusCard(snapshot, { width: 72, now: NOW, stale: false });
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /5h ███░░ 68%/);
	assert.match(lines[0] ?? "", /Week ██░░░ 39%/);
	assert.ok((lines[0]?.length ?? 0) <= 72);
});

test("wraps into at most two quota blocks on a narrow terminal", () => {
	const lines = formatStatusCard(snapshot, { width: 42, now: NOW, stale: false });
	assert.ok(lines.length <= 2);
	assert.ok(lines.every((line) => line.length <= 42));
	assert.match(lines.join("\n"), /5h/);
	assert.match(lines.join("\n"), /Week/);
});

test("drops progress bars on an ultra-narrow terminal", () => {
	const lines = formatStatusCard(snapshot, { width: 24, now: NOW, stale: false });
	assert.ok(lines.length <= 2);
	assert.ok(lines.every((line) => line.length <= 24));
	assert.match(lines.join(" "), /5h:68%/);
	assert.match(lines.join(" "), /Week:39%/);
	assert.doesNotMatch(lines.join(""), /█|░/);
});

test("marks stale cards with a warning and the actual update time", () => {
	const lines = formatStatusCard(snapshot, { width: 120, now: NOW + 90_000, stale: true });
	assert.match(lines.join(" "), /⚠/);
	assert.match(lines.join(" "), /1m ago|90s ago|now/);
});

test("counts CJK unavailable labels as double width when choosing a layout", () => {
	const lines = formatStatusCard(
		{ fetchedAt: NOW, fiveHour: snapshot.fiveHour },
		{ width: 22, now: NOW, stale: false },
	);
	assert.ok(lines.every((line) => [...line].reduce((width, char) => width + (char.codePointAt(0)! > 0xff ? 2 : 1), 0) <= 22));
});

test("renders an unavailable window without inventing a percent", () => {
	const lines = formatStatusCard(
		{ fetchedAt: NOW, fiveHour: snapshot.fiveHour },
		{ width: 120, now: NOW, stale: false },
	);
	assert.match(lines.join(" "), /Week 不可用/);
	assert.doesNotMatch(lines.join(" "), /Week \S+ \d+%/);
});

test("colors remaining quota by threshold", () => {
	assert.equal(quotaColor(50), "green");
	assert.equal(quotaColor(49), "yellow");
	assert.equal(quotaColor(25), "yellow");
	assert.equal(quotaColor(24), "orange");
	assert.equal(quotaColor(10), "orange");
	assert.equal(quotaColor(9), "red");
});

test("formats a compact status bar with colored remaining bars", () => {
	const paint = {
		green: (text: string) => `<g>${text}</g>`,
		yellow: (text: string) => `<y>${text}</y>`,
		orange: (text: string) => `<o>${text}</o>`,
		red: (text: string) => `<r>${text}</r>`,
	};
	assert.equal(
		formatStatusBar(snapshot, { stale: false, paint }),
		"Codex 5h <g>███░░</g> 68% Week <y>██░░░</y> 39%",
	);
	assert.equal(
		formatStatusBar(snapshot, { stale: true, paint }),
		"Codex 5h <g>███░░</g> 68% Week <y>██░░░</y> 39% ⚠",
	);
	assert.equal(formatStatusBar(undefined, { stale: false, paint }), "Codex usage unavailable");
});

test("paints a critically low remaining bar red", () => {
	const paint = {
		green: (text: string) => `<g>${text}</g>`,
		yellow: (text: string) => `<y>${text}</y>`,
		orange: (text: string) => `<o>${text}</o>`,
		red: (text: string) => `<r>${text}</r>`,
	};
	assert.equal(
		formatStatusBar(
			{
				fetchedAt: NOW,
				fiveHour: { usedPercent: 92 },
				weekly: { usedPercent: 80 },
			},
			{ stale: false, paint },
		),
		"Codex 5h <r>░░░░░</r> 8% Week <o>█░░░░</o> 20%",
	);
});
