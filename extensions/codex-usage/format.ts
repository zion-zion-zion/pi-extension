import type { UsageSnapshot, UsageWindow } from "./parser.ts";

export interface FormatOptions {
	width: number;
	now: number;
	stale: boolean;
}

export type QuotaColor = "green" | "yellow" | "orange" | "red";

export type QuotaPaint = Record<QuotaColor, (text: string) => string>;

export interface StatusBarOptions {
	stale: boolean;
	paint?: QuotaPaint;
}

const FILLED = "█";
const EMPTY = "░";
const UNAVAILABLE = "不可用";

export function remainingPercent(usedPercent: number): number {
	return clamp(100 - usedPercent, 0, 100);
}

export function quotaColor(remaining: number): QuotaColor {
	if (remaining >= 50) return "green";
	if (remaining >= 25) return "yellow";
	if (remaining >= 10) return "orange";
	return "red";
}

export function formatResetRemaining(resetAt: number | undefined, now: number): string | undefined {
	if (resetAt === undefined) return undefined;
	const remainingMs = resetAt - now;
	if (remainingMs <= 0) return "expired";

	const totalMinutes = Math.floor(remainingMs / 60_000);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	return `${Math.max(1, minutes)}m`;
}

export function formatStatusCard(snapshot: UsageSnapshot, options: FormatOptions): string[] {
	const header = snapshot.planType ? `Codex · ${snapshot.planType}` : "Codex";
	const time = options.stale
		? `⚠ ${formatFetchedAgo(snapshot.fetchedAt, options.now)}`
		: `· ${formatFetchedAgo(snapshot.fetchedAt, options.now)}`;
	const fiveHourWide = windowBlock(snapshot.fiveHour, "5h", 10, options.now);
	const weeklyWide = windowBlock(snapshot.weekly, "Week", 10, options.now);
	const fiveHourShort = windowBlock(snapshot.fiveHour, "5h", 5, options.now);
	const weeklyShort = windowBlock(snapshot.weekly, "Week", 5, options.now);
	const fiveHourCompact = compactWindow(snapshot.fiveHour, "5h");
	const weeklyCompact = compactWindow(snapshot.weekly, "Week");

	const layouts: string[][] = [
		joinLine([header, fiveHourWide, "│", weeklyWide, time], "   "),
		joinLine([header, fiveHourShort, "│", weeklyShort, time], "  "),
		joinLine([header, fiveHourShort, "│", weeklyShort], "  "),
		[joinTokens([header, fiveHourShort], "  "), joinTokens([weeklyShort, time], "  ")],
		joinLine([fiveHourCompact, weeklyCompact], "  "),
		[fiveHourCompact, weeklyCompact],
	];

	for (const lines of layouts) {
		if (lines.every((line) => visibleWidth(line) <= options.width)) return lines;
	}

	return [fiveHourCompact, weeklyCompact].map((line) => truncate(line, options.width));
}

export function formatStatusBar(snapshot: UsageSnapshot | undefined, options: StatusBarOptions): string {
	if (!snapshot) return "Codex usage unavailable";
	const text = [
		"Codex",
		statusBarWindow(snapshot.fiveHour, "5h", options.paint),
		statusBarWindow(snapshot.weekly, "Week", options.paint),
	].join(" ");
	return options.stale ? `${text} ⚠` : text;
}

function windowBlock(window: UsageWindow | undefined, label: string, cells: number, now: number): string {
	if (!window) return `${label} ${UNAVAILABLE}`;
	const remaining = remainingPercent(window.usedPercent);
	const bar = progressBar(remaining, cells);
	const percent = `${Math.round(remaining)}%`;
	const reset = formatResetRemaining(window.resetAt, now);
	const core = `${label} ${bar} ${percent}`;
	return reset ? `${core} · ${reset}` : core;
}

function compactWindow(window: UsageWindow | undefined, label: string): string {
	if (!window) return `${label}:${UNAVAILABLE}`;
	return `${label}:${Math.round(remainingPercent(window.usedPercent))}%`;
}

function statusBarWindow(window: UsageWindow | undefined, label: string, paint?: QuotaPaint): string {
	if (!window) return `${label} ${UNAVAILABLE}`;
	const remaining = remainingPercent(window.usedPercent);
	const bar = progressBar(remaining, 5);
	const colored = paint ? paint[quotaColor(remaining)](bar) : bar;
	return `${label} ${colored} ${Math.round(remaining)}%`;
}

function progressBar(remaining: number, cells: number): string {
	const filled = clamp(Math.round((remaining / 100) * cells), 0, cells);
	return FILLED.repeat(filled) + EMPTY.repeat(cells - filled);
}

function formatFetchedAgo(fetchedAt: number, now: number): string {
	const delta = Math.max(0, now - fetchedAt);
	if (delta < 45_000) return "now";
	if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
	if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m ago`;
	if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))}h ago`;
	return `${Math.max(1, Math.floor(delta / 86_400_000))}d ago`;
}

function joinLine(parts: Array<string | undefined>, spacer: string): string[] {
	return [joinTokens(parts, spacer)];
}

function joinTokens(parts: Array<string | undefined>, spacer: string): string {
	return parts.filter((part) => part && part.length > 0).join(spacer);
}

function visibleWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char);
	return width;
}

function charWidth(char: string): number {
	if ("█░│⚠·…".includes(char)) return 1;
	const code = char.codePointAt(0) ?? 0;
	return code > 0xff ? 2 : 1;
}

function truncate(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return width === 1 ? "…" : "";
	let result = "";
	let used = 0;
	for (const char of text) {
		const next = charWidth(char);
		if (used + next >= width) break;
		result += char;
		used += next;
	}
	return `${result}…`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
