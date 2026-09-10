import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsageResponse } from "./parser.ts";

const FETCHED_AT = 1_700_000_000_000;

test("parses standard primary/secondary windows into 5-hour and weekly usage", () => {
	const snapshot = parseUsageResponse(
		{
			plan_type: "pro",
			primary_window: {
				used_percent: 32,
				window_minutes: 300,
				resets_at: 1_700_000_800,
			},
			secondary_window: {
				used_percent: 61,
				window_minutes: 10_080,
				resets_at: 1_700_008_000,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.planType, "pro");
	assert.equal(snapshot.fetchedAt, FETCHED_AT);
	assert.deepEqual(snapshot.fiveHour, {
		usedPercent: 32,
		resetAt: 1_700_000_800_000,
		windowMinutes: 300,
	});
	assert.deepEqual(snapshot.weekly, {
		usedPercent: 61,
		resetAt: 1_700_008_000_000,
		windowMinutes: 10_080,
	});
});

test("identifies windows by duration even when primary/secondary are reversed", () => {
	const snapshot = parseUsageResponse(
		{
			primary_window: {
				used_percent: 61,
				window_minutes: 10_080,
				resets_at: 1_700_008_000,
			},
			secondary_window: {
				used_percent: 32,
				window_minutes: 300,
				resets_at: 1_700_000_800,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.fiveHour?.usedPercent, 32);
	assert.equal(snapshot.weekly?.usedPercent, 61);
});

test("falls back to primary/secondary names when window duration is missing", () => {
	const snapshot = parseUsageResponse(
		{
			planType: "plus",
			primary_window: {
				usedPercent: 10,
				resetsAt: 1_700_000_800_000,
			},
			secondary_window: {
				usedPercent: 20,
				resetsAt: 1_700_008_000_000,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.planType, "plus");
	assert.equal(snapshot.fiveHour?.usedPercent, 10);
	assert.equal(snapshot.fiveHour?.resetAt, 1_700_000_800_000);
	assert.equal(snapshot.weekly?.usedPercent, 20);
});

test("ignores unknown fields and still parses recognized windows", () => {
	const snapshot = parseUsageResponse(
		{
			plan_type: "pro",
			mystery: { nested: true },
			primary_window: {
				used_percent: 32,
				window_minutes: 300,
				extra_metric: 9,
			},
			future_window: {
				used_percent: 1,
				window_minutes: 60,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.fiveHour?.usedPercent, 32);
	assert.equal(snapshot.weekly, undefined);
});

test("keeps a valid window when the other window is missing", () => {
	const snapshot = parseUsageResponse(
		{
			secondary_window: {
				used_percent: 61,
				window_minutes: 10_080,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.fiveHour, undefined);
	assert.equal(snapshot.weekly?.usedPercent, 61);
});

test("treats a window with a missing used percent as unavailable", () => {
	const snapshot = parseUsageResponse(
		{
			primary_window: {
				window_minutes: 300,
				resets_at: 1_700_000_800,
			},
			secondary_window: {
				used_percent: 61,
				window_minutes: 10_080,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.fiveHour, undefined);
	assert.equal(snapshot.weekly?.usedPercent, 61);
});

test("rejects payloads with no recognizable 5-hour or weekly window", () => {
	assert.throws(
		() => parseUsageResponse({ plan_type: "pro", unknown_window: { used_percent: 3, window_minutes: 15 } }, FETCHED_AT),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal((error as { code?: string }).code, "invalid_response");
			assert.match(error.message, /incompatible|unavailable/i);
			return true;
		},
	);
});

test("clamps used percent below 0 and above 100", () => {
	const snapshot = parseUsageResponse(
		{
			primary_window: {
				used_percent: -12,
				window_minutes: 300,
			},
			secondary_window: {
				used_percent: 140,
				window_minutes: 10_080,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.fiveHour?.usedPercent, 0);
	assert.equal(snapshot.weekly?.usedPercent, 100);
});

test("treats non-numeric used percent as unavailable", () => {
	const snapshot = parseUsageResponse(
		{
			primary_window: {
				used_percent: "n/a",
				window_minutes: 300,
			},
			secondary_window: {
				used_percent: 61,
				window_minutes: 10_080,
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.fiveHour, undefined);
	assert.equal(snapshot.weekly?.usedPercent, 61);
});

test("accepts nested rate_limits primary/secondary windows", () => {
	const snapshot = parseUsageResponse(
		{
			rate_limits: {
				primary: {
					used_percent: 32,
					window_duration_mins: 300,
					resets_at: 1_700_000_800,
				},
				secondary: {
					used_percent: 61,
					window_minutes: 10_080,
					resets_at: 1_700_008_000,
				},
			},
		},
		FETCHED_AT,
	);

	assert.equal(snapshot.fiveHour?.usedPercent, 32);
	assert.equal(snapshot.weekly?.usedPercent, 61);
});
